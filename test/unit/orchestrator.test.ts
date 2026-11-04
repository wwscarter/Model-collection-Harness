import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { buildOrchestratorPrompt, parseOrchestratorPlan, selectOrchestratorModel } from '../../src/core/routing/Orchestrator';

function model(id: string, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id, name: id, provider: 'custom', apiKey: 'test', baseURL: 'http://127.0.0.1/v1', modelId: id,
    enabled: true, priority: 0, capabilities: [{ type: 'reasoning', score: 80 }], maxTokens: 4096,
    costPer1kTokens: { input: 0.01, output: 0.02 }, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 },
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...overrides,
  };
}

describe('DeepSeek orchestrator', () => {
  it('selects an enabled DeepSeek model as the master', () => {
    const deepseek = model('deepseek-chat', { provider: 'deepseek', name: 'DeepSeek Chat' });
    expect(selectOrchestratorModel([model('gpt'), deepseek])?.id).toBe('deepseek-chat');
    expect(selectOrchestratorModel([model('gpt')])).toBeUndefined();
  });

  it('builds a model catalogue prompt', () => {
    const prompt = buildOrchestratorPrompt({ prompt: 'fix the bug', orchestratorId: 'deepseek', availableModels: [model('deepseek', { provider: 'deepseek' }), model('reviewer')], projectRoot: '/p', files: ['src/a.ts'], memory: 'uses pnpm' });
    expect(prompt).toContain('id=reviewer');
    expect(prompt).toContain('fix the bug');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('uses pnpm');
    expect(prompt).toContain('JSON only');
  });

  it('parses and filters a valid delegate plan', () => {
    const models = [model('deepseek', { provider: 'deepseek' }), model('reviewer'), model('disabled', { enabled: false })];
    const plan = parseOrchestratorPlan(JSON.stringify({
      mode: 'delegate', taskType: 'code', complexity: 'high', plan: 'inspect then fix',
      subagents: [
        { modelId: 'reviewer', role: 'review', instruction: 'Review the API.' },
        { modelId: 'deepseek', role: 'self', instruction: 'ignored' },
        { modelId: 'disabled', role: 'bad', instruction: 'ignored' },
      ],
      verify: true,
    }), models, 'deepseek');
    expect(plan).toMatchObject({ mode: 'delegate', taskType: 'code', complexity: 'high', verify: true });
    expect(plan?.subagents.map((item) => item.modelId)).toEqual(['reviewer']);
  });

  it('downgrades delegate without valid subagents and keeps verify plans', () => {
    const models = [model('deepseek', { provider: 'deepseek' })];
    const plan = parseOrchestratorPlan(JSON.stringify({ mode: 'delegate', subagents: [{ modelId: 'missing', instruction: 'x' }] }), models, 'deepseek');
    expect(plan?.mode).toBe('direct');
    const verify = parseOrchestratorPlan(JSON.stringify({ mode: 'verify', subagents: [] }), models, 'deepseek');
    expect(verify?.mode).toBe('verify');
    expect(verify?.verify).toBe(true);
  });
});
