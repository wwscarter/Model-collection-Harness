import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ModelConfig } from '../../src/core/models/ModelConfig';
import { getModelOperations, supportsOperation, validateModelOperations, type ModelOperations } from '../../src/core/models/ModelOperations';
import { ModelRegistry } from '../../src/core/models/ModelRegistry';
import { ModelStorage } from '../../src/core/storage/ModelStorage';
import { snapshotModel } from '../../src/core/models/ModelSnapshot';
import { AgentRouter } from '../../src/core/routing/AgentRouter';
import { RoutingPolicyEngine } from '../../src/core/routing/RoutingPolicy';
import { selectPlanningModel, selectUtilityModel } from '../../src/core/routing/ModelCollaboration';
import { buildOrchestratorPrompt, parseOrchestratorPlan } from '../../src/core/routing/Orchestrator';
import { buildExecutionPlan } from '../../src/core/agent/RunOrchestrator';
import { fetchModelIdentifiers, testModelConnection } from '../../src/core/providers/ModelConnection';
import { createProvider } from '../../src/core/providers/ModelProvider';

function model(id: string, operations?: ModelOperations): ModelConfig {
  return {
    id, modelId: id, provider: 'custom', name: id, baseURL: 'http://127.0.0.1/v1', apiKey: '',
    enabled: true, priority: 0, capabilities: [{ type: 'reasoning', score: 90 }],
    contextWindow: 8192, maxTokens: 1024, costPer1kTokens: { input: 0, output: 0 },
    rateLimit: { requestsPerMinute: 60, tokensPerDay: 10_000 }, createdAt: new Date(), updatedAt: new Date(),
    ...(operations === undefined ? {} : { operations }),
  };
}
const imageOperations: ModelOperations = {
  'image.generate': {
    protocol: 'openai-images', score: 95, estimatedCostUsd: 0.04, expectedDurationMs: 60_000,
    limits: { sizes: ['1024x1024'], formats: ['png'], transparentBackground: true },
    defaults: { size: '1024x1024', format: 'png', quality: 'medium' },
    pricing: { inputTextPerMillion: 5, inputImagePerMillion: 8, outputImagePerMillion: 30 },
  },
};
afterEach(() => vi.unstubAllGlobals());

describe('executable model operations', () => {
  it('keeps legacy text compatibility without implicitly adding text to media configurations', () => {
    expect(getModelOperations(model('legacy'))).toEqual({ 'text.chat': { protocol: 'text' } });
    expect(supportsOperation(model('legacy'), 'text.chat')).toBe(true);
    expect(supportsOperation(model('image', imageOperations), 'text.chat')).toBe(false);
    expect(supportsOperation(model('image', imageOperations), 'image.generate')).toBe(true);
    expect(supportsOperation(model('future-video', { 'video.generate': { protocol: 'unconfigured' } }), 'video.generate')).toBe(false);
  });

  it.each([
    {},
    { 'image.generate': { protocol: 'text' } },
    { 'video.generate': { protocol: 'openai-images' } },
    { 'text.chat': { protocol: 'text', score: 101 } },
    { 'image.generate': { protocol: 'openai-images', estimatedCostUsd: -1 } },
    { 'image.generate': { protocol: 'openai-images', limits: { formats: ['gif'] } } },
    { 'image.generate': { protocol: 'openai-images', limits: { sizes: ['1024x1024'] }, defaults: { size: '1536x1024' } } },
    { 'image.generate': { protocol: 'openai-images', defaults: { quality: 'xhigh' } } },
    { 'image.generate': { protocol: 'openai-images', limits: { qualities: ['xhigh'] } } },
    { 'image.generate': { protocol: 'openai-images', limits: { qualities: ['low', 'high', 'low'] } } },
    { 'image.generate': { protocol: 'openai-images', limits: { qualities: ['low'] }, defaults: { quality: 'high' } } },
    { 'image.generate': { protocol: 'openai-images', defaults: { size: 'auto' } } },
    { 'image.generate': { protocol: 'openai-images', defaults: { size: 'banana' } } },
    { 'image.generate': { protocol: 'openai-images', defaults: { size: '00x1024' } } },
    { 'image.generate': { protocol: 'openai-images', defaults: { size: '1024x00' } } },
    { 'image.generate': { protocol: 'openai-images', defaults: { size: '99999x99999' } } },
    { 'image.generate': { protocol: 'openai-images', limits: { sizes: ['auto'] } } },
    { 'image.generate': { protocol: 'openai-images', limits: { sizes: ['1024x0'] } } },
    { 'image.generate': { protocol: 'openai-images', limits: { sizes: ['1024x1024', 'banana'] } } },
  ])('rejects invalid or incompatible capability metadata %j', (operations) => {
    expect(() => validateModelOperations(operations)).toThrow();
  });

  it('round-trips operations and pricing without leaking mutable input or snapshots', () => {
    const storage = new ModelStorage(':memory:');
    try {
      const registry = new ModelRegistry(storage, { initializePresets: false, persist: true });
      const input = model('image', structuredClone(imageOperations));
      registry.registerModel(input);
      input.operations!['image.generate']!.limits!.sizes!.push('invalid-mutation');
      const snapshot = snapshotModel(registry.getModel('image')!);
      snapshot.operations!['image.generate']!.pricing!.inputTextPerMillion = 999;
      const rehydrated = new ModelRegistry(storage, { initializePresets: false, persist: true });
      expect(rehydrated.getModel('image')!.operations).toEqual(imageOperations);
      expect(registry.getModel('image')!.operations).toEqual(imageOperations);
      registry.getModel('image')!.operations!['image.generate']!.limits!.formats!.push('webp');
      expect(registry.getModel('image')!.operations).toEqual(imageOperations);
      expect(() => registry.setPrimaryModel('image')).toThrow('只有支持文本对话');
    } finally { storage.close(); }
  });

  it('migrates a database without operations and fails closed on corrupt explicit metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-operations-'));
    const file = path.join(dir, 'models.db');
    let store: ModelStorage | undefined;
    try {
      store = new ModelStorage(file);
      store.saveModel(model('old-text'));
      store.saveModel(model('damaged-media', imageOperations));
      store.close();
      const db = new Database(file);
      db.exec('ALTER TABLE models DROP COLUMN operations');
      db.close();
      store = new ModelStorage(file);
      expect(supportsOperation(store.loadModel('old-text')!, 'text.chat')).toBe(true);
      store.saveModel(model('damaged-media', imageOperations));
      store.close();
      const corrupt = new Database(file);
      corrupt.prepare('UPDATE models SET operations = ? WHERE id = ?').run('{broken', 'damaged-media');
      corrupt.close();
      store = new ModelStorage(file);
      expect(supportsOperation(store.loadModel('damaged-media')!, 'text.chat')).toBe(false);
      expect(supportsOperation(store.loadModel('damaged-media')!, 'image.generate')).toBe(false);
    } finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('text role isolation', () => {
  it('excludes media from executor, rules, fallback, collaborators, planner and utility roles', async () => {
    const text = model('text');
    const image = { ...model('image', imageOperations), isPrimary: true, intelligenceScore: 100 };
    const router = new AgentRouter({ getEnabledModels: () => [image, text] });
    expect((await router.routeTask({ id: 'run', type: 'general', description: 'hello' })).modelId).toBe('text');
    const policy = new RoutingPolicyEngine(router, {
      version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'media-rule', enabled: true, priority: 99, when: {}, then: { primaryModelId: 'image', fallbackModelIds: ['image'], collaboratorModelIds: ['image'] } }],
    });
    const decision = await policy.routeTask({ id: 'run', type: 'general', description: 'hello' }, [image, text]);
    expect(decision.modelId).toBe('text');
    expect(decision.fallbackModels).not.toContain('image');
    expect(decision.collaboratorModelIds).not.toContain('image');
    expect(selectPlanningModel([image, text])?.id).toBe('text');
    expect(selectPlanningModel([image, text], undefined, 'image')).toBeUndefined();
    expect(selectUtilityModel([image, text])?.id).toBe('text');
    expect(selectUtilityModel([image, text], undefined, 'image')).toBeUndefined();
    const plan = buildExecutionPlan({ primary: text, models: [image, text], decision: { ...decision, fallbackModels: ['image'], collaboratorModelIds: ['image'], strategy: 'parallel' }, requestedCollaborators: [image] });
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['text']);
    expect(plan.collaborators).toEqual([]);
    expect(buildOrchestratorPrompt({ prompt: 'hello', availableModels: [image, text], orchestratorId: 'planner' })).not.toContain('id=image');
    const suggestion = parseOrchestratorPlan(JSON.stringify({ mode: 'delegate', subagents: [{ modelId: 'image', instruction: 'analyze' }] }), [image, text], 'planner', 'text');
    expect(suggestion?.subagents).toEqual([]);
  });

  it('reports an absent text capability clearly when only media is configured', async () => {
    const router = new AgentRouter({ getEnabledModels: () => [model('image', imageOperations)] });
    await expect(router.routeTask({ id: 'run', type: 'general', description: 'hello' })).rejects.toThrow('没有支持文本对话');
  });
});

describe('media configuration probes', () => {
  it('rejects a direct text provider call for media before choosing either adapter implementation', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const legacyProviders of [false, true]) expect(() => createProvider(model('image', imageOperations), { legacyProviders })).toThrow('不支持文本调用');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never calls a text endpoint to test either saved or unsaved media configuration', async () => {
    const registry = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    registry.registerModel(model('image', imageOperations));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const input of [
      { id: 'image', provider: 'custom' },
      { provider: 'custom', baseURL: 'http://127.0.0.1/v1', modelId: 'draft-image', operations: imageOperations },
    ]) expect(await testModelConnection(input, registry)).toMatchObject({ success: false, probeUnsupported: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes prediction/media catalogue entries without treating discovery as capability proof', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ models: [
      { name: 'models/chat', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/video', supportedGenerationMethods: ['predictLongRunning'] },
      { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
    ] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchModelIdentifiers({ provider: 'google', apiKey: 'key' }, { getModel: () => undefined })).toEqual({ models: ['chat', 'video'] });
  });
});
