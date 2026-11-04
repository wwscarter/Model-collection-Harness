import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import type { RoutingDecision } from '../../src/core/routing/AgentRouter';
import { buildExecutionPlan, chooseRevisionModel } from '../../src/core/agent/RunOrchestrator';

function model(id: string, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id, name: id, provider: 'custom', apiKey: 'test', baseURL: 'http://127.0.0.1/v1', modelId: id,
    enabled: true, priority: 0, capabilities: [], maxTokens: 4096, costPer1kTokens: { input: 1, output: 1 },
    rateLimit: { requestsPerMinute: 60, tokensPerDay: 10_000 }, createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function decision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    modelId: 'primary', taskType: 'general', complexity: 'medium', reason: 'test', confidence: 0.8,
    alternativeModels: [], estimatedCost: 0, estimatedDuration: 0, ...overrides,
  };
}

describe('RunOrchestrator execution plan', () => {
  it('orders primary/fallback candidates and keeps requested collaborators', () => {
    const models = [model('primary'), model('backup'), model('agent')];
    const plan = buildExecutionPlan({ primary: models[0], decision: decision({ fallbackModels: ['backup'] }), models, requestedCollaborators: [models[2]] });
    expect(plan.candidates.map((item) => item.id)).toEqual(['primary', 'backup']);
    expect(plan.collaborators.map((item) => item.id)).toEqual(['agent']);
  });

  it('auto-selects two cheap available collaborators for a parallel rule', () => {
    const models = [model('primary'), model('expensive', { costPer1kTokens: { input: 10, output: 10 } }), model('cheap-a', { priority: 1 }), model('cheap-b', { priority: 2 })];
    const plan = buildExecutionPlan({
      primary: models[0],
      decision: decision({ strategy: 'parallel', collaboratorModelIds: [] }),
      models,
      isAvailable: (id) => id !== 'expensive',
    });
    expect(plan.strategy).toBe('parallel');
    expect(plan.collaborators.map((item) => item.id)).toEqual(['cheap-a', 'cheap-b']);
    expect(plan.collaborators).toHaveLength(2);
  });

  it('uses the fallback model for escalate revision only', () => {
    const models = [model('primary'), model('strong')];
    const plan = buildExecutionPlan({ primary: models[0], decision: decision({ strategy: 'escalate', fallbackModels: ['strong'] }), models });
    expect(chooseRevisionModel(plan, models[0])?.id).toBe('strong');
    const verifyPlan = buildExecutionPlan({ primary: models[0], decision: decision({ strategy: 'plan+verify', fallbackModels: ['strong'] }), models });
    expect(chooseRevisionModel(verifyPlan, models[0])?.id).toBe('primary');
  });
});
