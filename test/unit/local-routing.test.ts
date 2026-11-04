import { describe, expect, it } from 'vitest';
import { LocalRoutingModel } from '@core/routing/LocalRoutingModel';
import { AgentRouter } from '@core/routing/AgentRouter';

describe('LocalRoutingModel', () => {
  it('classifies coding tasks without downloading a model', async () => {
    const model = new LocalRoutingModel();
    const result = await model.classify({ type: 'general', description: '请修复这个 TypeScript API 的 bug', complexity: undefined });
    expect(result.taskType).toBe('code');
    expect(result.backend).toBe('heuristic');
    expect(model.getStatus().available).toBe(false);
  });

  it('infers complexity from the user task text', async () => {
    const model = new LocalRoutingModel();
    await expect(model.classify({ type: 'general', description: '你好', complexity: undefined })).resolves.toMatchObject({ complexity: 'medium' });
    await expect(model.classify({ type: 'general', description: '请全面重构这个系统的架构', complexity: undefined })).resolves.toMatchObject({ complexity: 'high' });
  });

  it('accepts an injected local completion adapter and falls back on malformed JSON', async () => {
    const model = new LocalRoutingModel({ complete: async () => '{"taskType":"analysis","complexity":"high","confidence":0.9}' });
    await expect(model.classify({ type: 'general', description: 'inspect', complexity: undefined })).resolves.toMatchObject({ taskType: 'analysis', complexity: 'high', backend: 'local-model' });

    const fallback = new LocalRoutingModel({ complete: async () => 'not-json' });
    await expect(fallback.classify({ type: 'general', description: 'write code', complexity: undefined })).resolves.toMatchObject({ taskType: 'code', backend: 'heuristic' });
  });

  it('feeds the local classification into the router while remaining observable', async () => {
    const registry = {
      getEnabledModels: () => [
        { id: 'code-model', name: 'Code', provider: 'openai' as const, apiKey: 'test-key', modelId: 'code', enabled: true, priority: 0, capabilities: [{ type: 'code' as const, score: 95 }], maxTokens: 1000, rateLimit: { requestsPerMinute: 1, tokensPerDay: 1000 }, costPer1kTokens: { input: 1, output: 1 }, createdAt: new Date(), updatedAt: new Date() },
      ],
    };
    const router = new AgentRouter(registry);
    const decision = await router.routeTask({ id: 'task', type: 'general', description: '修复 TypeScript API bug' });
    expect(decision.modelId).toBe('code-model');
    expect(decision.reason).toContain('code');
    expect(router.getLocalModelStatus().backend).toBe('heuristic');
  });
});
