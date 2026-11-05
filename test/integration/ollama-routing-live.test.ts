import { describe, expect, it } from 'vitest';
import { OllamaRoutingBackend } from '@core/routing/OllamaRoutingBackend';
import { LocalRoutingModel } from '@core/routing/LocalRoutingModel';
import { AgentRouter } from '@core/routing/AgentRouter';
import { RoutingPolicyEngine } from '@core/routing/RoutingPolicy';
import { DEFAULT_ROUTING_SETTINGS } from '@core/routing/RoutingSettings';
import type { ModelConfig } from '@core/models/ModelConfig';

// Explicit opt-in: normal CI remains independent of locally installed software or weights.
describe.skipIf(process.env.NEWAI_TEST_OLLAMA !== '1')('installed local Ollama routing', () => {
  it('probes, warms up, and selects an executor through the real classification and policy chain', async () => {
    const backend = new OllamaRoutingBackend({ ...DEFAULT_ROUTING_SETTINGS.classifier, mode: 'ollama', timeoutMs: 10_000 });
    const local = new LocalRoutingModel({ classifier: backend });
    const model = (id: string, code: number): ModelConfig => ({
      id, name: id, provider: 'custom', baseURL: 'http://127.0.0.1:9999/v1', modelId: id, apiKey: '',
      enabled: true, priority: 0, maxTokens: 1000, contextWindow: 4096,
      capabilities: [{ type: 'code', score: code }, { type: 'reasoning', score: 50 }],
      rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 },
      costPer1kTokens: { input: 0, output: 0 }, createdAt: new Date(), updatedAt: new Date(),
    });
    const models = [model('coding-executor', 95), model('general-executor', 30)];
    try {
      expect(await backend.probe()).toMatchObject({ reachable: true, modelInstalled: true, available: true });
      await backend.warmup();
      const policy = new RoutingPolicyEngine(new AgentRouter({ getEnabledModels: () => models }, undefined, local));
      const decision = await policy.routeTask({ id: 'local-smoke', type: 'general', description: '写一个 TypeScript 函数，把字符串数组中的空字符串过滤掉，只输出这个小函数。' }, models, undefined, { signal: AbortSignal.timeout(15_000) });
      expect(decision).toMatchObject({ modelId: 'coding-executor', taskType: 'code', classification: { backend: 'ollama', model: DEFAULT_ROUTING_SETTINGS.classifier.model, promptVersion: 'v3' } });
      expect(decision.classification?.durationMs).toBeGreaterThan(0);
      expect(decision.classification?.fallbackReason).toBeUndefined();
      const pinned = await policy.routeTask({ id: 'pinned', type: 'general', description: '写代码' }, models, undefined, { skipSemantic: true });
      expect(pinned.classification?.backend).toBe('heuristic');
    } finally { backend.dispose(); }
  }, 60_000);
});
