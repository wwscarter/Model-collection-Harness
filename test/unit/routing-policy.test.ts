import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { AgentRouter } from '../../src/core/routing/AgentRouter';
import { DEFAULT_ROUTING_POLICY, loadRoutingPolicy, parseRoutingPolicy, validateRoutingPolicy, RoutingPolicyEngine, type RoutingPolicy } from '../../src/core/routing/RoutingPolicy';
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

  it('ranks every available model after the highest-ranked models reach their quotas', async () => {
    const models = [model('weak', { capabilities: [{ type: 'code', score: 10 }] }), model('best-available', { capabilities: [{ type: 'code', score: 85 }] }),
      ...[100, 99, 98].map((score) => model(`limited-${score}`, { capabilities: [{ type: 'code', score }] }))];
    const decision = await new RoutingPolicyEngine(routerFor(models)).routeTask(
      { id: 't', type: 'code', description: 'fix', complexity: 'high' }, models, { isAvailable: (id) => !id.startsWith('limited-') },
    );
    expect(decision.modelId).toBe('best-available');
    expect(decision.alternativeModels).toEqual(['weak']);
  });

  it('uses the next matching rule when a higher-priority rule is unavailable and updates the estimate', async () => {
    const models = [model('best', { capabilities: [{ type: 'code', score: 95 }] }),
      model('chosen', { capabilities: [{ type: 'code', score: 50 }], costPer1kTokens: { input: 0.1, output: 0.2 } }), model('limited')];
    const policy: RoutingPolicy = { version: 1, defaults: { strategy: 'single' }, rules: [
      { id: 'unavailable', enabled: true, priority: 10, when: {}, then: { primaryModelId: 'limited', strategy: 'parallel' } },
      { id: 'available', enabled: true, priority: 5, when: {}, then: { primaryModelId: 'chosen', strategy: 'plan' } },
    ] };
    const decision = await new RoutingPolicyEngine(routerFor(models), policy).routeTask(
      { id: 't', type: 'code', description: 'fix', complexity: 'medium', estimatedTokens: 1000 }, models, { isAvailable: (id) => id !== 'limited' },
    );
    expect(decision).toMatchObject({ modelId: 'chosen', ruleId: 'available', strategy: 'plan' });
    expect(decision.estimatedCost).toBeCloseTo(0.13);
    expect(decision.fallbackModels).toEqual(['best']);
  });

  it('exposes parallel collaborators and accepts the escalate strategy', async () => {
    const models = [model('primary'), model('analyst'), model('strong')];
    const policy: RoutingPolicy = {
      version: 1,
      rules: [{ id: 'escalate', enabled: true, priority: 5, when: { taskTypes: ['code'] }, then: { primaryModelId: 'primary', strategy: 'escalate', collaboratorModelIds: ['analyst'], fallbackModelIds: ['strong'] } }],
      defaults: { strategy: 'single' },
    };
    const decision = await new RoutingPolicyEngine(routerFor(models), policy).routeTask({ id: 't', type: 'code', description: 'fix', complexity: 'medium' }, models);
    expect(decision).toMatchObject({ strategy: 'escalate', collaboratorModelIds: ['analyst'] });
    expect(decision.fallbackModels).toContain('strong');
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

  it('does not turn an unrecognized task condition into a rule matching every task', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-routing-'));
    const file = path.join(directory, 'rules.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ version: 1, rules: [{ id: 'typo', when: { taskTypes: ['coding'] }, then: { primaryModelId: 'm' } }] }));
      expect(loadRoutingPolicy(file)).toMatchObject({ policy: { rules: [] }, diagnostics: [expect.stringContaining('无效')] });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('routing policy save validation', () => {
  it('accepts supported rules and fills legacy defaults without touching the filesystem', () => {
    expect(validateRoutingPolicy({ rules: [{ id: 'code', when: { taskTypes: ['code'] }, then: { primaryModelId: 'm' } }] })).toMatchObject({
      version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'code', then: { primaryModelId: 'm', strategy: 'single' } }],
    });
  });

  it.each([
    null,
    {},
    { rules: [], defaults: { strategy: 'unsupported' } },
    { rules: [{ id: 'rule', enabled: 'yes', then: { strategy: 'single' } }] },
    { rules: [{ id: 'rule', when: { taskTypes: ['coding'] }, then: { strategy: 'single' } }] },
    { rules: [{ id: 'rule', when: { taskType: ['code'] }, then: { strategy: 'single' } }] },
    { rules: [{ id: 'rule', then: { strategy: 'single', fallbackModelIds: ['a', 'b', 'c', 'd'] } }] },
    { rules: [{ id: 'rule', then: { primaryModelId: '' } }] },
    { rules: [{ id: 'same', then: { strategy: 'single' } }, { id: 'same', then: { strategy: 'plan' } }] },
  ])('rejects unsupported or lossy settings before saving: %j', (value) => {
    expect(() => validateRoutingPolicy(value)).toThrow();
  });

  it('keeps startup recovery tolerant when one existing rule is invalid', () => {
    expect(parseRoutingPolicy({ rules: [{ id: 'valid', then: { strategy: 'single' } }, { id: 'invalid', then: {} }] })).toMatchObject({
      policy: { rules: [{ id: 'valid' }] }, diagnostics: [expect.any(String)],
    });
  });
});

describe('ModelQuota', () => {
  it('reserves the last request atomically and uses indexed single-model token usage when available', () => {
    const getModelMetrics = vi.fn(() => []);
    const getModelTokenUsage = vi.fn(() => 0);
    const quota = new ModelQuota({ getModelMetrics, getModelTokenUsage });
    const limited = model('m', { rateLimit: { requestsPerMinute: 1, tokensPerDay: 1000 } });
    quota.reserve(limited);
    expect(() => quota.reserve(limited)).toThrow('配额');
    expect(getModelTokenUsage).toHaveBeenCalledWith('m', { from: expect.any(Date), to: expect.any(Date) });
    expect(getModelMetrics).not.toHaveBeenCalled();
  });

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
