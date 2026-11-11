import { fitPromptParts, modelContextBudget } from '@core/context/ContextBudget';
import type { ModelConfig } from '@core/models/ModelConfig';
import { hasUsableCredentials } from '@core/models/ModelConfig';
import { snapshotModel } from '@core/models/ModelSnapshot';
import { buildOrchestratorPrompt, parseOrchestratorPlan, selectOrchestratorModel } from '@core/routing/Orchestrator';
import { BudgetExceededError } from '@core/routing/RunBudget';
import type { RunContext } from './RunContext';
import { costOf } from './runHelpers';
import { presentPlan } from './presentPlan';
import { supportsOperation } from '@core/models/ModelOperations';

/** Apply optional orchestration suggestions to the routed task. */
export async function planStage(ctx: RunContext): Promise<void> {
  const plannerModels = ctx.deps.models.getAllModels().filter((candidate) => supportsOperation(candidate, 'text.chat') && candidate.enabled && hasUsableCredentials(candidate) && ctx.deps.quota.isAvailable(candidate));
  const explicitSingle = Boolean(ctx.decision.ruleId && ctx.decision.strategy === 'single');
  const mode = ctx.request.planningMode ?? ctx.deps.routingSettings?.planning.executionMode ?? 'auto';
  const needsPlanning = mode !== 'auto' || (!ctx.pinned && !explicitSingle && ctx.deps.routingSettings?.planning.mode !== 'off'
    && (ctx.decision.complexity === 'high' || ['plan', 'plan+verify', 'parallel', 'escalate'].includes(ctx.decision.strategy ?? 'single')));
  const configuredPlanner = ctx.deps.routingSettings?.planning.modelId;
  const planner = needsPlanning ? selectOrchestratorModel(plannerModels, configuredPlanner) ?? (mode !== 'auto' && !configuredPlanner ? ctx.model : undefined) : undefined;
  if (planner) {
    const planSpan = ctx.trace.child('plan', 'planning', { modelId: planner.id, modelSnapshot: snapshotModel(planner), role: 'planner', executorModelId: ctx.model.id });
    const planModelSpan = planSpan.child('model', 'planning-model', { modelId: planner.id, modelSnapshot: snapshotModel(planner), role: 'planner' });
    const planInvocationId = ctx.deps.observability.recordInvocationStart(ctx.runId, planner.id);
    let invocationEnded = false;
    try {
      ctx.runBudget.assertAvailable();
      const planningBudget = modelContextBudget([planner], 1500);
      const planningPrompt = fitPromptParts((parts) => buildOrchestratorPrompt({
        prompt: ctx.request.prompt, availableModels: plannerModels, orchestratorId: planner.id, executionModelId: ctx.model.id,
        priorContext: parts[1],
        projectRoot: ctx.projectRoot,
        files: parts[2] ? parts[2].split('\n') : [], memory: parts[0],
      }), [ctx.memory?.text ?? '', ctx.priorContext ?? '', ctx.projectContext?.files.slice(0, 60).map((file) => file.path).join('\n') ?? ''], planningBudget.maxInputTokens);
      ctx.emit('session:model-switched', { sessionId: ctx.sessionId, taskId: ctx.taskId, runId: ctx.runId, modelId: planner.id, role: 'planning', reason: '为任务生成结构化执行建议', confidence: ctx.decision.confidence });
      // createProvider reserves planner quota immediately before the request.
      const response = await ctx.createProvider(planner).invoke(planningPrompt, { maxTokens: planningBudget.maxOutputTokens, temperature: 0.2, signal: AbortSignal.any([ctx.controller.signal, AbortSignal.timeout(30000)]) });
      const cost = costOf(response.inputTokens, response.outputTokens, planner);
      ctx.deps.observability.recordInvocationEnd(planInvocationId, response.inputTokens, response.outputTokens, planner.costPer1kTokens, 'success');
      invocationEnded = true;
      planModelSpan.end({ inputTokens: response.inputTokens, outputTokens: response.outputTokens, cost });
      const parsed = parseOrchestratorPlan(response.content, plannerModels, planner.id, ctx.model.id);
      if (parsed) {
        ctx.orchestration = parsed;
        ctx.planningModelId = planner.id;
        // Explicit collaborators and execution choices belong to the scheduler.
        if (!ctx.collaboratorModels.length && !ctx.decision.collaboratorModelIds?.length) {
          ctx.collaboratorModels.push(...parsed.subagents
            .map((subagent) => ctx.deps.models.getModel(subagent.modelId))
            .filter((candidate): candidate is ModelConfig => Boolean(candidate && candidate.enabled && hasUsableCredentials(candidate) && ctx.deps.quota.isAvailable(candidate))));
        }
        if (!ctx.decision.ruleId && parsed.verify && ctx.decision.strategy !== 'escalate')
          ctx.decision = { ...ctx.decision, strategy: 'plan+verify' };
        ctx.routeSpan.setAttributes({ planningModelId: planner.id });
        planSpan.end({ attributes: { valid: true, mode: parsed.mode, suggestedTaskType: parsed.taskType, suggestedComplexity: parsed.complexity, subagents: parsed.subagents.map((subagent) => subagent.modelId), verify: parsed.verify } });
      }
      else {
        planSpan.end({ attributes: { valid: false, fallback: 'normal-routing' } });
      }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!invocationEnded)
        ctx.deps.observability.recordInvocationEnd(planInvocationId, 0, 0, planner.costPer1kTokens, 'failure', message);
      planModelSpan.end({ status: 'failed', error: message });
      planSpan.end({ status: ctx.controller.signal.aborted ? 'cancelled' : 'failed', error: message });
      if (error instanceof BudgetExceededError)
        throw error;
      if (ctx.controller.signal.aborted)
        throw ctx.cancellationError();
      // An unavailable or malformed optional plan leaves normal routing intact.
    }
  }
  await presentPlan(ctx);
}
