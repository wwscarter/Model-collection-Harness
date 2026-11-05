import { describe, expect, it } from 'vitest';
import { snapshotModel, hasLegacyPresetRates } from '@core/models/ModelSnapshot';
import type { ModelConfig } from '@core/models/ModelConfig';

function config(): ModelConfig {
  return {
    id: 'google-gemini-pro', name: 'Current executor', provider: 'custom', modelId: 'actual-current-model',
    apiKey: 'secret-never-in-trace', baseURL: 'https://user:password@gateway.example/v1/chat/completions?key=url-secret#private',
    costPer1kTokens: { input: 0.2, output: 0.4 }, capabilities: [], rateLimit: { requestsPerMinute: 10, tokensPerDay: 1000 },
    maxTokens: 1000, enabled: true, priority: 0, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-11-05T01:02:03Z'),
  };
}

describe('model identity snapshots', () => {
  it('separates the immutable configuration ID from the actual requested model and whitelists only safe identity fields', () => {
    const snapshot = snapshotModel(config());
    expect(snapshot).toEqual({ configurationId: 'google-gemini-pro', modelId: 'actual-current-model', name: 'Current executor', provider: 'custom', endpointOrigin: 'https://gateway.example', costPer1kTokens: { input: 0.2, output: 0.4 }, pricingBasis: 'configured-token-rates', configurationUpdatedAt: '2026-11-05T01:02:03.000Z' });
    const json = JSON.stringify(snapshot);
    for (const sensitive of ['secret-never-in-trace', 'password', 'url-secret', 'chat/completions', 'private', 'apiKey']) expect(json).not.toContain(sensitive);
  });

  it('captures a detached copy before later configuration and price edits', () => {
    const model = config();
    const snapshot = snapshotModel(model);
    model.name = 'Renamed'; model.modelId = 'replacement'; model.costPer1kTokens.input = 99; model.updatedAt.setFullYear(2027);
    expect(snapshot).toMatchObject({ name: 'Current executor', modelId: 'actual-current-model', costPer1kTokens: { input: 0.2 }, configurationUpdatedAt: '2026-11-05T01:02:03.000Z' });
  });

  it('uses safe provider defaults and tolerates invalid endpoint metadata', () => {
    expect(snapshotModel({ ...config(), provider: 'google', baseURL: undefined }).endpointOrigin).toBe('https://generativelanguage.googleapis.com');
    expect(snapshotModel({ ...config(), baseURL: 'invalid endpoint' }).endpointOrigin).toBeUndefined();
    expect(snapshotModel({ ...config(), baseURL: 'file:///tmp/private' }).endpointOrigin).toBeUndefined();
  });

  it('flags unchanged original preset rates only when the actual provider or requested model has changed', () => {
    const edited = { ...config(), id: 'google-gemini-pro', provider: 'deepseek' as const, modelId: 'deepseek-chat', costPer1kTokens: { input: 0.0005, output: 0.0015 } };
    expect(hasLegacyPresetRates(edited)).toBe(true);
    expect(snapshotModel(edited)).toMatchObject({ pricingBasis: 'configured-token-rates', legacyPresetRates: true, costPer1kTokens: { input: 0.0005, output: 0.0015 } });
    expect(edited.costPer1kTokens).toEqual({ input: 0.0005, output: 0.0015 });
    expect(hasLegacyPresetRates({ ...edited, provider: 'google', modelId: 'gemini-pro' })).toBe(false);
    expect(hasLegacyPresetRates({ ...edited, provider: 'google', modelId: 'gemini-new' })).toBe(true);
    expect(hasLegacyPresetRates({ ...edited, costPer1kTokens: { input: 0.0006, output: 0.0015 } })).toBe(false);
    expect(hasLegacyPresetRates({ ...edited, id: 'my-google-gemini-pro' })).toBe(false);
    expect(snapshotModel({ ...edited, id: 'custom-user-config' })).not.toHaveProperty('legacyPresetRates');
    const rendererDraft: { id: string; provider: string; modelId: string; costPer1kTokens: { input: number; output: number } } = { ...edited };
    expect(hasLegacyPresetRates(rendererDraft)).toBe(true);
  });

  it.each([
    ['openai-gpt-4-turbo', 'openai', 'gpt-4-turbo-preview', 0.01, 0.03],
    ['anthropic-claude-3-sonnet', 'anthropic', 'claude-3-sonnet-20240229', 0.003, 0.015],
    ['google-gemini-pro', 'google', 'gemini-pro', 0.0005, 0.0015],
  ] as const)('recognizes the exact preset identity %s without inferring from an ID pattern', (id, provider, modelId, input, output) => {
    const preset = { ...config(), id, provider, modelId, costPer1kTokens: { input, output } };
    expect(hasLegacyPresetRates(preset)).toBe(false);
    expect(hasLegacyPresetRates({ ...preset, modelId: 'edited-model' })).toBe(true);
  });
});
