import { supportsOperation } from '@core/models/ModelOperations';
import { hasUsableCredentials, type ModelConfig } from '@core/models/ModelConfig';
import type { RoutingDecision, RoutingStrategy } from '@core/routing/AgentRouter';

export interface ExecutionPlanInput {
  primary: ModelConfig;
  decision: RoutingDecision;
  models: ModelConfig[];
  requestedCollaborators?: ModelConfig[];
  isAvailable?: (modelId: string) => boolean;
  maxCollaborators?: number;
}

export interface ExecutionPlan {
  primary: ModelConfig;
  candidates: ModelConfig[];
  collaborators: ModelConfig[];
  strategy: RoutingStrategy;
}

function cost(model: ModelConfig): number {
  return model.costPer1kTokens.input + model.costPer1kTokens.output;
}

function usable(model: ModelConfig | undefined, isAvailable?: (id: string) => boolean): model is ModelConfig {
  return Boolean(model && model.enabled && supportsOperation(model, 'text.chat') && hasUsableCredentials(model) && (isAvailable?.(model.id) ?? true));
}

/**
 * Pure planning for the execution stage: which models may be attempted, which
 * collaborators run in parallel, and whether a revision should escalate. Kept
 * outside main.ts so routing/fallback policy can be tested without Electron.
 */
export function buildExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
  const available = input.isAvailable ?? (() => true);
  const candidates: ModelConfig[] = [];
  for (const id of [input.primary.id, ...(input.decision.fallbackModels ?? [])]) {
    const model = input.models.find((candidate) => candidate.id === id);
    if (usable(model, available) && !candidates.some((candidate) => candidate.id === model.id)) candidates.push(model);
  }
  const strategy = input.decision.strategy ?? 'single';
  const maxCollaborators = Math.max(2, Math.min(4, input.maxCollaborators ?? 4));
  const collaborators: ModelConfig[] = [];
  for (const model of input.requestedCollaborators ?? []) {
    if (!usable(model, available) || model.id === input.primary.id) continue;
    if (!collaborators.some((candidate) => candidate.id === model.id)) collaborators.push(model);
    if (collaborators.length >= maxCollaborators) break;
  }
  if (!collaborators.length && (strategy === 'parallel' || input.decision.collaboratorModelIds?.length)) {
    const requested = input.decision.collaboratorModelIds?.length
      ? input.decision.collaboratorModelIds
      : input.models
        .filter((model) => model.id !== input.primary.id && usable(model, available))
        .sort((a, b) => cost(a) - cost(b) || a.priority - b.priority)
        .slice(0, 2)
        .map((model) => model.id);
    for (const id of requested) {
      const model = input.models.find((candidate) => candidate.id === id);
      if (!usable(model, available) || model.id === input.primary.id) continue;
      if (!collaborators.some((candidate) => candidate.id === model.id)) collaborators.push(model);
      if (collaborators.length >= maxCollaborators) break;
    }
    if (collaborators.length === 1) collaborators.length = 0;
  }
  return { primary: input.primary, candidates, collaborators, strategy };
}

/** Escalate revisions use the strongest/next fallback; verify revisions stay on the executor. */
export function chooseRevisionModel(plan: ExecutionPlan, executionModel: ModelConfig): ModelConfig {
  if (plan.strategy !== 'escalate') return executionModel;
  return plan.candidates.find((candidate) => candidate.id !== executionModel.id) ?? executionModel;
}
