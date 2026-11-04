import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { buildParallelAgentPrompt, buildPlannedTask, buildPlanningPrompt, buildSynthesisPrompt, runParallelAgents, selectPlanningModel } from '../../src/core/routing/ModelCollaboration';

function model(id: string, reasoning: number, intelligenceScore = 70, priority = 0): ModelConfig {
  return {
    id,
    provider: 'custom',
    name: id,
    apiKey: '',
    baseURL: 'http://127.0.0.1/v1',
    modelId: id,
    contextWindow: 32_000,
    intelligenceScore,
    costPer1kTokens: { input: 0, output: 0 },
    capabilities: [{ type: 'reasoning', score: reasoning }],
    maxTokens: 2048,
    rateLimit: { requestsPerMinute: 60, tokensPerDay: 10_000 },
    enabled: true,
    priority,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('model collaboration', () => {
  it('selects a different enabled reasoning model for high-complexity planning', () => {
    const selected = selectPlanningModel([model('executor', 80), model('planner', 92, 95)], 'executor');
    expect(selected?.id).toBe('planner');
  });

  it('does not select a disabled, non-reasoning, or same execution model', () => {
    const candidates = [
      model('executor', 95),
      { ...model('disabled', 100), enabled: false },
      { ...model('creative', 0), capabilities: [{ type: 'creative' as const, score: 100 }] },
    ];
    expect(selectPlanningModel(candidates, 'executor')).toBeUndefined();
  });

  it('never picks a planning model that has no credentials', () => {
    const keyless = { ...model('keyless', 100, 99), provider: 'openai' as const, baseURL: undefined };
    expect(selectPlanningModel([keyless, model('planner', 90)], 'executor')?.id).toBe('planner');
  });

  it('keeps the original user task while adding a separate planning prompt', () => {
    const userTask = 'Build a small project';
    expect(buildPlanningPrompt(userTask)).toContain(userTask);
    expect(buildPlannedTask(userTask, 'Inspect files, then implement and verify')).toContain(userTask);
    expect(buildPlannedTask(userTask, 'Inspect files, then implement and verify')).toContain('Execution plan');
  });

  it('starts all selected agents concurrently and retains per-model results', async () => {
    let started = 0;
    let signalStarted: () => void = () => undefined;
    let release: () => void = () => undefined;
    const allStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const work = runParallelAgents(['claude', 'gpt'], async (id) => {
      started += 1;
      if (started === 2) signalStarted();
      await gate;
      return `${id} report`;
    });

    await allStarted;
    expect(started).toBe(2);
    release();
    const results = await work;
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(results.map((result) => result.status === 'fulfilled' ? result.value : '')).toEqual(['claude report', 'gpt report']);
  });

  it('builds role-specific independent agent prompts and a coordinator synthesis prompt', () => {
    const task = 'Compare migration strategies';
    const first = buildParallelAgentPrompt(task, 0);
    const second = buildParallelAgentPrompt(task, 1);
    expect(first).toContain(task);
    expect(first).not.toBe(second);
    expect(buildSynthesisPrompt(task, [{ modelName: 'Claude', content: 'Keep the old API' }])).toContain('Claude');
  });
});
