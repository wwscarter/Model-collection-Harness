import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { ModelRegistry } from '../../src/core/models/ModelRegistry';
import { ModelStorage } from '../../src/core/storage/ModelStorage';
import type { ModelStore } from '../../src/core/storage/ModelStorage';
import { configureEncryptionKeyProvider, encryptAPIKey, resetEncryptionKeyProvider } from '../../src/utils/crypto';

const directories: string[] = [];
const stores: Array<{ close(): void }> = [];
const testKey = Buffer.alloc(32, 19);

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-model-settings-'));
  directories.push(directory);
  return path.join(directory, 'models.db');
}

function openStore(file: string): ModelStorage {
  const storage = new ModelStorage(file);
  stores.push(storage);
  return storage;
}

function sampleModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'local-model', name: 'Local service', provider: 'custom',
    apiKey: 'sk-saved-settings-secret', baseURL: 'http://127.0.0.1:11434/v1',
    modelId: 'local-reasoner', providerCategory: 'local_ollama',
    availableModels: ['local-reasoner', 'local-chat'], temperature: 0.6,
    enableThinking: true, isPrimary: false, contextWindow: 65_536,
    intelligenceScore: 88, capabilities: [{ type: 'reasoning', score: 88 }],
    costPer1kTokens: { input: 0, output: 0 }, maxTokens: 4096,
    rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 },
    enabled: true, priority: 2,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

afterEach(() => {
  for (const storage of stores.splice(0)) storage.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  resetEncryptionKeyProvider();
});

describe('model settings persistence', () => {
  it('retains endpoint, inference, catalog, primary selection, and encrypted credentials after reopening', () => {
    configureEncryptionKeyProvider(() => testKey);
    const file = databasePath();
    const original = sampleModel({ temperature: 1.3, enableThinking: false, isPrimary: true });
    const first = openStore(file);
    first.saveModel(original);
    first.close();

    const raw = new Database(file);
    try {
      const credential = raw.prepare('SELECT api_key FROM model_credentials WHERE model_id = ?').get(original.id) as { api_key: string };
      expect(credential.api_key).not.toContain(original.apiKey);
    } finally { raw.close(); }

    const reopened = openStore(file);
    expect(reopened.loadModel(original.id)).toEqual(original);
  });

  it('migrates the original schema without losing its endpoint, credential, or model metadata', () => {
    configureEncryptionKeyProvider(() => testKey);
    const file = databasePath();
    const legacy = new Database(file);
    try {
      legacy.exec(`
        CREATE TABLE models (
          id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, model_id TEXT NOT NULL,
          capabilities TEXT NOT NULL, cost_per_1k_tokens TEXT NOT NULL, max_tokens INTEGER NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE model_credentials (
          model_id TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
          api_key TEXT NOT NULL, base_url TEXT
        );
      `);
      legacy.prepare('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'legacy', 'custom', 'Legacy gateway', 'legacy-reasoner',
        JSON.stringify([{ type: 'reasoning', score: 87 }]), JSON.stringify({ input: 0.01, output: 0.03 }),
        8192, 1, 4, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
      );
      legacy.prepare('INSERT INTO model_credentials VALUES (?, ?, ?)').run(
        'legacy', encryptAPIKey('sk-legacy-secret'), 'https://legacy.example/v1',
      );
    } finally { legacy.close(); }

    const migrated = openStore(file);
    expect(migrated.loadModel('legacy')).toMatchObject({
      name: 'Legacy gateway', modelId: 'legacy-reasoner', apiKey: 'sk-legacy-secret',
      baseURL: 'https://legacy.example/v1', contextWindow: 8192, maxTokens: 8192, intelligenceScore: 87,
      providerCategory: 'compatible_gateway', availableModels: ['legacy-reasoner'],
      temperature: 0.6, enableThinking: true, isPrimary: false, priority: 4, enabled: true,
      rateLimit: { requestsPerMinute: 0, tokensPerDay: 0 },
    });
    const registry = new ModelRegistry(migrated, { initializePresets: false, persist: true });
    registry.updateModel('legacy', { temperature: 0, enableThinking: false, availableModels: ['legacy-reasoner', 'legacy-chat'] });
    migrated.close();

    const reopened = openStore(file);
    expect(reopened.loadModel('legacy')).toMatchObject({
      apiKey: 'sk-legacy-secret', baseURL: 'https://legacy.example/v1', contextWindow: 8192,
      temperature: 0, enableThinking: false, availableModels: ['legacy-reasoner', 'legacy-chat'],
    });
  });
});

describe('model settings registry', () => {
  it('protects catalog arrays from mutations to registration inputs and read results', () => {
    const registry = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    const catalog = ['local-chat', 'local-reasoner'];
    const registered = registry.registerModel(sampleModel({ availableModels: catalog }));
    catalog.push('outside-input');
    registered.availableModels!.push('outside-registration-result');
    registry.getModel('local-model')!.availableModels!.push('outside-model-read');
    registry.getAllModels()[0].availableModels!.push('outside-list-read');
    registry.getEnabledModels()[0].availableModels!.push('outside-enabled-read');

    expect(registry.getModel('local-model')!.availableModels).toEqual(['local-chat', 'local-reasoner']);
  });

  it('enables the chosen primary, clears the old selection, and persists both without disabling other models', () => {
    const storage = openStore(':memory:');
    const registry = new ModelRegistry(storage, { initializePresets: false, persist: true });
    registry.registerModel(sampleModel({ id: 'previous', apiKey: '', isPrimary: true }));
    registry.registerModel(sampleModel({ id: 'chosen', apiKey: '', enabled: false }));
    registry.registerModel(sampleModel({ id: 'other', apiKey: '', priority: 9 }));

    const models = registry.setPrimaryModel('chosen');

    expect(models.filter((model) => model.isPrimary).map((model) => model.id)).toEqual(['chosen']);
    expect(registry.getModel('chosen')).toMatchObject({ enabled: true, isPrimary: true });
    expect(registry.getModel('previous')).toMatchObject({ enabled: true, isPrimary: false });
    expect(registry.getModel('other')).toMatchObject({ enabled: true, isPrimary: false, priority: 9 });
    const rehydrated = new ModelRegistry(storage, { initializePresets: false, persist: true });
    expect(rehydrated.getAllModels().filter((model) => model.isPrimary).map((model) => model.id)).toEqual(['chosen']);
    expect(rehydrated.getModel('chosen')!.enabled).toBe(true);
    expect(rehydrated.getModel('previous')!.isPrimary).toBe(false);
  });

  it('rejects an unknown primary without changing the current selection', () => {
    const registry = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    registry.registerModel(sampleModel({ isPrimary: true }));
    const before = registry.getAllModels();

    expect(() => registry.setPrimaryModel('missing')).toThrow(/Model not found/);
    expect(registry.getAllModels()).toEqual(before);
  });

  it('rolls back the entire SQLite primary batch when saving a credential fails', () => {
    const storage = openStore(':memory:');
    const registry = new ModelRegistry(storage, { initializePresets: false, persist: true });
    registry.registerModel(sampleModel({ id: 'previous', apiKey: '', isPrimary: true }));
    registry.registerModel(sampleModel({ id: 'chosen', apiKey: '', isPrimary: false }));
    const before = registry.getAllModels();
    configureEncryptionKeyProvider(() => { throw new Error('System credential store unavailable'); });

    expect(() => registry.updateModel('chosen', { isPrimary: true, apiKey: 'replacement-secret' })).toThrow('System credential store unavailable');
    expect(registry.getAllModels()).toEqual(before);
    expect(storage.getAllModels().filter((model) => model.isPrimary).map((model) => model.id)).toEqual(['previous']);
    expect(storage.loadModel('chosen')!.apiKey).toBe('');
  });

  it('does not publish a rejected new configuration or update when a batch store fails', () => {
    const original = sampleModel({ apiKey: '', isPrimary: true });
    const storage: ModelStore = {
      saveModel: vi.fn(), saveModels: vi.fn(() => { throw new Error('Storage is read-only'); }),
      loadModel: () => original, getAllModels: () => [original], deleteModel: vi.fn(),
    };
    const registry = new ModelRegistry(storage, { initializePresets: false, persist: true });
    const before = registry.getAllModels();
    expect(() => registry.registerModel(sampleModel({ id: 'new', apiKey: '', isPrimary: true }))).toThrow('Storage is read-only');
    expect(() => registry.updateModel(original.id, { name: 'Rejected name' })).toThrow('Storage is read-only');
    expect(registry.getAllModels()).toEqual(before);
    expect(storage.saveModel).not.toHaveBeenCalled();
  });

  it('keeps memory unchanged when a legacy single-model store rejects mutations', () => {
    const original = sampleModel({ apiKey: '' });
    const fail = () => { throw new Error('Disk unavailable'); };
    const storage: ModelStore = { saveModel: fail, loadModel: () => original, getAllModels: () => [original], deleteModel: fail };
    const registry = new ModelRegistry(storage, { initializePresets: false, persist: true });
    const before = registry.getAllModels();
    expect(() => registry.updateModel(original.id, { name: 'Rejected name' })).toThrow('Disk unavailable');
    expect(() => registry.deleteModel(original.id)).toThrow('Disk unavailable');
    expect(registry.getAllModels()).toEqual(before);
  });

  it('rejects Anthropic temperatures above one while keeping the supported global range for other providers', () => {
    const registry = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    expect(() => registry.registerModel(sampleModel({ provider: 'anthropic', temperature: 1.1 }))).toThrow('Anthropic temperature');
    expect(registry.registerModel(sampleModel({ provider: 'anthropic', temperature: 1 })).temperature).toBe(1);
    expect(registry.registerModel(sampleModel({ id: 'creative', provider: 'custom', temperature: 1.5 })).temperature).toBe(1.5);
  });

  it.each([NaN, -0.1, 1.6, Infinity])('rejects invalid temperature %s without altering an existing model', (temperature) => {
    const registry = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    registry.registerModel(sampleModel());

    expect(() => registry.updateModel('local-model', { temperature })).toThrow(/temperature/);
    expect(() => registry.registerModel(sampleModel({ id: 'invalid', temperature }))).toThrow(/temperature/);
    expect(registry.getModel('local-model')!.temperature).toBe(0.6);
    expect(registry.getModel('invalid')).toBeUndefined();
  });
});
