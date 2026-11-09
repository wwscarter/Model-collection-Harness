import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROUTING_SETTINGS, loadRoutingSettings, saveRoutingSettings, validateRoutingSettings } from '@core/routing/RoutingSettings';

const directories: string[] = [];
const settings = () => structuredClone(DEFAULT_ROUTING_SETTINGS);
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('RoutingSettings', () => {
  it('defaults to unified Pi calls and persists the explicit legacy fallback', () => {
    const previous = settings(); delete previous.legacyProviders;
    expect(validateRoutingSettings(previous).legacyProviders).toBe(false);
    expect(validateRoutingSettings({ ...settings(), legacyProviders: true }).legacyProviders).toBe(true);
    expect(() => validateRoutingSettings({ ...settings(), legacyProviders: 'true' })).toThrow('布尔值');
  });
  it('migrates plan execution defaults and accepts each user execution preference', () => {
    expect(validateRoutingSettings({ ...settings(), planning: { mode: 'auto' } }).planning.executionMode).toBe('auto');
    for (const executionMode of ['auto', 'confirm', 'only']) expect(validateRoutingSettings({ ...settings(), planning: { mode: 'auto', executionMode } }).planning.executionMode).toBe(executionMode);
    expect(() => validateRoutingSettings({ ...settings(), planning: { mode: 'auto', executionMode: 'other' } })).toThrow('计划执行模式');
  });
  it('migrates settings without budget fields and validates saved runtime limits', () => {
    const legacy = settings(); delete legacy.budget;
    expect(validateRoutingSettings(legacy).budget).toEqual({ maxCostUsd: 0.25, maxDurationMs: 600_000 });
    expect(validateRoutingSettings({ ...settings(), budget: { maxCostUsd: 2.5, maxDurationMs: 1_200_000 } }).budget).toEqual({ maxCostUsd: 2.5, maxDurationMs: 1_200_000 });
    for (const maxCostUsd of [0, -1, 1001, NaN, Infinity, '1']) expect(() => validateRoutingSettings({ ...settings(), budget: { maxCostUsd, maxDurationMs: 600_000 } })).toThrow('费用上限');
    for (const maxDurationMs of [0, 59999, 3600001, NaN, Infinity, '600000']) expect(() => validateRoutingSettings({ ...settings(), budget: { maxCostUsd: 1, maxDurationMs } })).toThrow('运行时间');
    expect(() => validateRoutingSettings({ ...settings(), budget: { maxCostUsd: 1, maxDurationMs: 600_000, disabled: true } })).toThrow('未知字段');
  });
  it('starts with rules and returns independent defaults for absent or invalid files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-settings-')); directories.push(directory);
    const file = path.join(directory, 'routing.json');
    const first = loadRoutingSettings(file);
    expect(first).toEqual(DEFAULT_ROUTING_SETTINGS);
    first.classifier.mode = 'ollama';
    expect(loadRoutingSettings(file).classifier.mode).toBe('rules');
    fs.writeFileSync(file, '{broken');
    expect(loadRoutingSettings(file)).toEqual(DEFAULT_ROUTING_SETTINGS);
  });

  it.each(['http://127.0.0.1:11434/', 'https://localhost:9443', 'http://[::1]:11434', 'http://127.0.0.2:11434'])('accepts the loopback root %s', (baseURL) => {
    expect(validateRoutingSettings({ ...settings(), classifier: { ...settings().classifier, baseURL } }).classifier.baseURL).toBe(new URL(baseURL).origin);
  });

  it.each(['https://example.com', 'http://192.168.1.4:11434', 'http://0.0.0.0:11434', 'file:///tmp/ollama', 'http://localhost/v1', 'http://127.0.0.1/x/..', 'http://user:pass@localhost', 'http://@localhost', 'http://localhost?', 'http://localhost#'])('rejects a nonlocal or non-root endpoint %s', (baseURL) => {
    expect(() => validateRoutingSettings({ ...settings(), classifier: { ...settings().classifier, baseURL } })).toThrow();
  });

  it('validates local model names, bounded values, optional role IDs and schema fields', () => {
    expect(validateRoutingSettings({ ...settings(), planning: { mode: 'off', modelId: 'planner' }, utilityModelId: 'archiver' })).toMatchObject({ planning: { modelId: 'planner' }, utilityModelId: 'archiver' });
    for (const model of ['qwen3:cloud', 'foo-cloud:2b', 'cloud/foo', '', 'a b', 'm'.repeat(201)]) {
      expect(() => validateRoutingSettings({ ...settings(), classifier: { ...settings().classifier, model } })).toThrow();
    }
    for (const timeoutMs of [0, 249, 30001, 300.5, NaN, '3000']) {
      expect(() => validateRoutingSettings({ ...settings(), classifier: { ...settings().classifier, timeoutMs } })).toThrow();
    }
    expect(() => validateRoutingSettings({ ...settings(), extra: true })).toThrow('未知字段');
    expect(() => validateRoutingSettings({ ...settings(), planning: { mode: 'master' } })).toThrow();
    expect(() => validateRoutingSettings({ ...settings(), utilityModelId: '\nsecret' })).toThrow();
  });

  it('atomically persists validated settings and preserves the previous file on validation or rename failure', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-settings-')); directories.push(directory);
    const file = path.join(directory, 'nested', 'routing.json');
    const original = saveRoutingSettings(file, settings());
    const previous = fs.readFileSync(file, 'utf8');
    expect(loadRoutingSettings(file)).toEqual(original);
    expect(() => saveRoutingSettings(file, { ...settings(), version: 2 })).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(previous);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk commit failed'); });
    expect(() => saveRoutingSettings(file, { ...settings(), planning: { mode: 'off' } })).toThrow('disk commit failed');
    expect(fs.readFileSync(file, 'utf8')).toBe(previous);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['routing.json']);
    expect(original.planning.mode).toBe('auto');
    rename.mockRestore();
  });
});
