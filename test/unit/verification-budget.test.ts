import { describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { BudgetExceededError, RunBudget } from '../../src/core/routing/RunBudget';
import { buildRevisionPrompt, shouldRevise, verifyCodeAnswer } from '../../src/core/agent/VerificationService';

const model: ModelConfig = {
  id: 'verifier', provider: 'deepseek', name: 'Verifier', apiKey: 'test', modelId: 'v',
  costPer1kTokens: { input: 0.01, output: 0.02 }, capabilities: [], maxTokens: 4096,
  rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 }, enabled: true, priority: 0,
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
};

describe('RunBudget', () => {
  it('blocks runs over cost, token or duration budgets', () => {
    let now = 1_000;
    const budget = new RunBudget({ maxCost: 0.01, maxDurationMs: 1_000, maxTokens: 100, now: () => now });
    budget.add({ cost: 0.009, tokens: 50 });
    expect(() => budget.assertAvailable()).not.toThrow();
    expect(() => budget.assertAvailable(0.002)).toThrow(BudgetExceededError);
    budget.add({ cost: 0.001, tokens: 60 });
    expect(() => budget.assertAvailable()).toThrow(BudgetExceededError);
    now += 2_000;
    expect(() => budget.assertAvailable()).toThrow('秒预算');
  });
});

describe('VerificationService', () => {
  it('runs a code audit with usage and identifies high issues for revision', async () => {
    const invoke = vi.fn(async () => ({
      content: JSON.stringify({ issues: [{ severity: 'high', category: 'security', description: 'eval', suggestion: 'remove eval' }], scores: { security: 40, performance: 90, quality: 90, logic: 90 }, overallScore: 60, approval: false }),
      inputTokens: 100, outputTokens: 50, modelId: 'v',
    }));
    const output = await verifyCodeAnswer({ content: 'fix:\n\n```ts\nconst x = eval(input);\n```', taskId: 't', executionModelId: 'exec', model, provider: { invoke } });
    expect(output?.audit.approval).toBe(false);
    expect(output?.inputTokens).toBe(100);
    expect(output?.cost).toBeCloseTo(0.002, 6);
    expect(shouldRevise(output!.audit)).toBe(true);
    expect(buildRevisionPrompt('fix it', 'old', output!.audit)).toContain('eval');
  });

  it('skips prose-only answers', async () => {
    const invoke = vi.fn();
    await expect(verifyCodeAnswer({ content: '普通回答', taskId: 't', executionModelId: 'exec', model, provider: { invoke } })).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
