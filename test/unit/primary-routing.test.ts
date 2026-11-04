import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '@core/models/ModelConfig';
import { AgentRouter } from '@core/routing/AgentRouter';

function model(id: string, score: number, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id, name: id, provider: 'custom', apiKey: '', baseURL: 'http://localhost:11434/v1', modelId: id,
    enabled: true, priority: 0, capabilities: [{ type: 'code', score }],
    maxTokens: 4096, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 },
    costPer1kTokens: { input: 0, output: 0 },
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...overrides,
  };
}

const task = { id: 'coding-task', type: 'code' as const, complexity: 'high' as const, description: 'Refactor the TypeScript API' };

describe('explicit primary routing', () => {
  it('uses the enabled primary even when another model has stronger capabilities', async () => {
    const primary = model('preferred', 15, { isPrimary: true, priority: 99 });
    const specialist = model('specialist', 99);
    const router = new AgentRouter({ getEnabledModels: () => [specialist, primary] });

    const decision = await router.routeTask(task);

    expect(decision.modelId).toBe('preferred');
    expect(decision.reason).toContain('Explicit primary model');
    expect(decision.alternativeModels).toEqual(['specialist']);
  });

  it('ignores a disabled primary and retains capability based automatic routing', async () => {
    const router = new AgentRouter({ getEnabledModels: () => [
      model('disabled-primary', 100, { isPrimary: true, enabled: false }),
      model('ordinary', 50),
      model('specialist', 95),
    ] });

    const decision = await router.routeTask(task);

    expect(decision.modelId).toBe('specialist');
    expect(decision.reason).toContain('Capability match');
    expect(decision.alternativeModels).toEqual(['ordinary']);
  });

  it('never routes to an enabled model without credentials', async () => {
    const keyless = model('keyless', 100, { provider: 'openai', baseURL: undefined, apiKey: '' });
    const usable = model('usable', 60, { provider: 'custom', apiKey: '', baseURL: 'http://127.0.0.1:11434/v1' });
    const router = new AgentRouter({ getEnabledModels: () => [keyless, usable] });
    const decision = await router.routeTask(task);
    expect(decision.modelId).toBe('usable');
  });

  it('explains when every enabled model is missing a key', async () => {
    const router = new AgentRouter({ getEnabledModels: () => [model('keyless', 100, { provider: 'openai', apiKey: '' })] });
    await expect(router.routeTask(task)).rejects.toThrow('API Key');
  });

  it('uses existing priority tie breaks when no primary is selected', async () => {
    const router = new AgentRouter({ getEnabledModels: () => [
      model('lower-priority', 85, { priority: 4 }),
      model('higher-priority', 85, { priority: 1 }),
    ] });

    const decision = await router.routeTask(task);

    expect(decision.modelId).toBe('higher-priority');
    expect(decision.reason).toContain('Capability match');
  });
});
