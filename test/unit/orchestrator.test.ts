import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { buildOrchestratorPrompt, buildSubagentInstruction, parseOrchestratorPlan, selectOrchestratorModel } from '../../src/core/routing/Orchestrator';

function model(id: string, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id, name: id, provider: 'custom', apiKey: 'test', baseURL: 'http://127.0.0.1/v1', modelId: id,
    enabled: true, priority: 0, capabilities: [{ type: 'reasoning', score: 80 }], maxTokens: 4096,
    costPer1kTokens: { input: 0.01, output: 0.02 }, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 },
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...overrides,
  };
}

describe('application planning', () => {
  it('selects a planner by reasoning capability without provider or primary preference', () => {
    const deepseek = model('deepseek-chat', { provider: 'deepseek', name: 'DeepSeek Chat', isPrimary: true });
    const planner = model('planner', { capabilities: [{ type: 'reasoning', score: 95 }] });
    expect(selectOrchestratorModel([deepseek, planner])?.id).toBe('planner');
    expect(selectOrchestratorModel([model('gpt')])?.id).toBe('gpt');
  });

  it('honors an explicit available planner and does not replace an unavailable selection', () => {
    const models = [model('preferred'), model('strong', { capabilities: [{ type: 'reasoning', score: 99 }] }), model('disabled', { enabled: false })];
    expect(selectOrchestratorModel(models, 'preferred')?.id).toBe('preferred');
    expect(selectOrchestratorModel(models, 'disabled')).toBeUndefined();
    expect(selectOrchestratorModel(models, 'removed')).toBeUndefined();
  });

  it('builds a model catalogue prompt', () => {
    const prompt = buildOrchestratorPrompt({ prompt: 'fix the bug', orchestratorId: 'deepseek', availableModels: [model('deepseek', { provider: 'deepseek' }), model('reviewer')], projectRoot: '/p', files: ['src/a.ts'], memory: 'uses pnpm' });
    expect(prompt).toContain('id=reviewer');
    expect(prompt).toContain('fix the bug');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('uses pnpm');
    expect(prompt).toContain('JSON only');
    expect(prompt).toContain('cannot change that selection');
    expect(prompt).not.toContain('only model allowed to produce the final answer');
  });

  it('preserves requirements at the end of a long task in planning and subagent prompts', () => {
    const task = 'Project requirement '.repeat(1000) + 'Final requirement: keep existing file names.';
    expect(buildOrchestratorPrompt({ prompt: task, availableModels: [], orchestratorId: 'lead' })).toContain(task);
    expect(buildSubagentInstruction(task, { modelId: 'analyst', role: 'analysis', instruction: 'Review the requirements.' })).toContain(task);
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

  it('keeps direct plans free of subagent invocations even when extra assignments are returned', () => {
    const models = [model('deepseek', { provider: 'deepseek' }), model('reviewer')];
    const plan = parseOrchestratorPlan(JSON.stringify({ mode: 'direct', subagents: [{ modelId: 'reviewer', instruction: 'Review the API.' }] }), models, 'deepseek');
    expect(plan).toMatchObject({ mode: 'direct', subagents: [] });
  });

  it('does not let an empty duplicate assignment hide a later valid assignment', () => {
    const models = [model('deepseek', { provider: 'deepseek' }), model('reviewer')];
    const plan = parseOrchestratorPlan(JSON.stringify({ mode: 'delegate', subagents: [
      { modelId: 'reviewer', instruction: '' }, { modelId: 'reviewer', instruction: 'Review the API.' },
    ] }), models, 'deepseek');
    expect(plan?.subagents).toMatchObject([{ modelId: 'reviewer', instruction: 'Review the API.' }]);
  });

  it('rejects invalid plan structures and excludes the selected executor from assignments', () => {
    const models = [model('planner'), model('executor'), model('reviewer')];
    expect(parseOrchestratorPlan('{}', models, 'planner')).toBeUndefined();
    expect(parseOrchestratorPlan('{"mode":"invented"}', models, 'planner')).toBeUndefined();
    expect(parseOrchestratorPlan('{"mode":"delegate","subagents":{}}', models, 'planner')).toBeUndefined();
    const parsed = parseOrchestratorPlan(JSON.stringify({ mode: 'delegate', subagents: [
      { modelId: 'executor', instruction: 'Do the final task.' }, { modelId: 'reviewer', instruction: 'Inspect the design.' },
    ] }), models, 'planner', 'executor');
    expect(parsed?.subagents.map((agent) => agent.modelId)).toEqual(['reviewer']);
  });
});
