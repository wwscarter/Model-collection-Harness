import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { AgentRouter } from '../../src/core/routing/AgentRouter';
import { DEFAULT_ROUTING_POLICY, loadRoutingPolicy, RoutingPolicyEngine, type RoutingPolicy } from '../../src/core/routing/RoutingPolicy';
import { ModelQuota } from '../../src/core/routing/ModelQuota';

function model(id: string, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id, name: id, provider: 'custom', apiKey: 'test-key', baseURL: 'http://127.0.0.1/v1', modelId: id,
    enabled: true, priority: 0, capabilities: [{ type: 'code', score: 80 }, { type: 'reasoning', score: 80 }],
    maxTokens: 4096, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 },
    costPer1kTokens: { input: 0, output: 0 }, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...overrides,
  };
}

describe('RoutingPolicyEngine', () => {
  const routerFor = (models: ModelConfig[]) => new AgentRouter({ getEnabledModels: () => models });

  it('applies the highest-priority matching rule and exposes a fallback chain', async () => {
    const models = [model('base'), model('primary', { capabilities: [{ type: 'code', score: 95 }] }), model('fallback')];
    const policy: RoutingPolicy = {
      version: 1,
      rules: [
        { id: 'low', enabled: true, priority: 1, when: { taskTypes: ['code'] }, then: { primaryModelId: 'base', strategy: 'single' } },
        { id: 'high', enabled: true, priority: 10, when: { taskTypes: ['code'], complexity: ['high'] }, then: { primaryModelId: 'primary', strategy: 'plan+verify', fallbackModelIds: ['fallback'] } },
      ],
      defaults: { strategy: 'single' },
    };
    const decision = await new RoutingPolicyEngine(routerFor(models), policy).routeTask({ id: 't', type: 'code', description: 'refactor the API', complexity: 'high' }, models);
    expect(decision).toMatchObject({ modelId: 'primary', strategy: 'plan+verify', ruleId: 'high' });
    expect(decision.fallbackModels).toEqual(expect.arrayContaining(['fallback']));
  });

  it('defaults high-complexity code to plan+verify', async () => {
    const models = [model('coder')];
    const decision = await new RoutingPolicyEngine(routerFor(models), DEFAULT_ROUTING_POLICY).routeTask({ id: 't', type: 'code', description: 'refactor', complexity: 'high' }, models);
    expect(decision.strategy).toBe('plan+verify');
  });

  it('skips a primary excluded by the availability guard', async () => {
    const models = [model('primary'), model('alternate', { capabilities: [{ type: 'code', score: 50 }] })];
    const policy: RoutingPolicy = { ...DEFAULT_ROUTING_POLICY, rules: [{ id: 'rule', enabled: true, priority: 1, when: { taskTypes: ['code'] }, then: { primaryModelId: 'primary' } }] };
    const decision = await new RoutingPolicyEngine(routerFor(models), policy).routeTask(
      { id: 't', type: 'code', description: 'fix', complexity: 'low' },
      models,
      { isAvailable: (id) => id !== 'primary' },
    );
    expect(decision.modelId).toBe('alternate');
    expect(decision.ruleId).toBeUndefined();
  });

  it('validates on-disk rules and ignores malformed entries', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-routing-'));
    const file = path.join(directory, 'rules.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      rules: [
        { id: 'ok', enabled: true, priority: 2, when: { taskTypes: ['code'] }, then: { primaryModelId: 'm', strategy: 'plan', fallbackModelIds: ['f'] } },
        { id: 'bad', then: {} },
        'not-an-object',
      ],
    }));
    const loaded = loadRoutingPolicy(file);
    expect(loaded.policy.rules).toHaveLength(1);
    expect(loaded.policy.rules[0]).toMatchObject({ id: 'ok', then: { primaryModelId: 'm', strategy: 'plan' } });
    expect(loaded.diagnostics.length).toBeGreaterThan(0);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe('ModelQuota', () => {
  it('enforces requests per minute and daily tokens', () => {
    let now = Date.parse('2026-11-04T08:00:00.000Z');
    const metrics = { getModelMetrics: () => [{ modelId: 'm', totalTokens: 950 }] } as never;
    const quota = new ModelQuota(metrics, () => now);
    const limited = model('m', { rateLimit: { requestsPerMinute: 1, tokensPerDay: 1_000 } });
    expect(quota.isAvailable(limited)).toBe(true);
    quota.record('m');
    expect(quota.isAvailable(limited)).toBe(false);
    now += 61_000;
    expect(quota.isAvailable(limited)).toBe(true); // RPM window expired; daily usage 950 is still below 1,000
    const dailyExhausted = { getModelMetrics: () => [{ modelId: 'm', totalTokens: 1_000 }] } as never;
    expect(new ModelQuota(dailyExhausted, () => now).isAvailable(limited)).toBe(false);
  });
});
