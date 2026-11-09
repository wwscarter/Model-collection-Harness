import { hasUsableCredentials } from '@core/models/ModelConfig';
import { snapshotModel } from '@core/models/ModelSnapshot';
import { awaitWithSignal } from '@core/tools/awaitWithSignal';
import type { RunContext } from './RunContext';
import { routingPriorContext } from './runHelpers';

/** Classify the request and select the execution model. */
export async function routeStage(ctx: RunContext): Promise<void> {
  ctx.storedSummary = ctx.deps.summaries.getSummary(ctx.sessionId);
  ctx.priorContext = routingPriorContext(ctx.request.history, ctx.storedSummary?.text);
  const pinnedCandidate = ctx.request.pinnedModelId ? ctx.deps.models.getModel(ctx.request.pinnedModelId) : undefined;
  ctx.pinned = pinnedCandidate && pinnedCandidate.enabled && hasUsableCredentials(pinnedCandidate) && ctx.deps.quota.isAvailable(pinnedCandidate) ? pinnedCandidate : undefined;
  if (ctx.request.pinnedModelId && !ctx.pinned)
    throw new Error('所选固定模型当前不可用，请检查模型配置与配额');
  ctx.routeSpan = ctx.trace.child('route', 'route', { requestedTaskType: ctx.request.taskType, requestedComplexity: ctx.request.complexity });
  try {
    ctx.decision = await awaitWithSignal(ctx.deps.routing.routeTask({ id: ctx.runId, type: (ctx.request.taskType || 'general') as any, description: ctx.request.prompt, complexity: ctx.request.complexity, priorContext: ctx.priorContext }, ctx.pinned ? [ctx.pinned] : ctx.deps.models.getAllModels(), { isAvailable: (modelId) => { const candidate = ctx.deps.models.getModel(modelId); return Boolean(candidate && ctx.deps.quota.isAvailable(candidate)); } }, { signal: ctx.controller.signal, skipSemantic: Boolean(ctx.pinned) }), ctx.controller.signal);
    if (ctx.pinned) {
      ctx.collaboratorModels.splice(0, ctx.collaboratorModels.length);
      ctx.decision = { ...ctx.decision, modelId: ctx.pinned.id, strategy: 'single' as const, reason: 'Session model override', alternativeModels: [], fallbackModels: [], collaboratorModelIds: [], ruleId: undefined };
    }
    const routedModel = ctx.deps.models.getModel(ctx.decision.modelId);
    const snapshots = (ids: string[] = []) => ids.flatMap((id) => { const candidate = ctx.deps.models.getModel(id); return candidate ? [snapshotModel(candidate)] : []; });
    ctx.routeSpan.end({ attributes: { modelId: ctx.decision.modelId, modelSnapshot: routedModel ? snapshotModel(routedModel) : undefined, taskType: ctx.decision.taskType, complexity: ctx.decision.complexity, confidence: ctx.decision.confidence, classification: ctx.decision.classification, alternatives: ctx.decision.alternativeModels, alternativeSnapshots: snapshots(ctx.decision.alternativeModels), fallbackModels: ctx.decision.fallbackModels, fallbackSnapshots: snapshots(ctx.decision.fallbackModels), strategy: ctx.decision.strategy, ruleId: ctx.decision.ruleId, pinned: Boolean(ctx.pinned) } });
  }
  catch (error) {
    const failure = ctx.controller.signal.aborted ? ctx.cancellationError() : error;
    ctx.routeSpan.end({ status: ctx.controller.signal.aborted ? 'cancelled' : 'failed', error: failure instanceof Error ? failure.message : String(failure) });
    throw failure;
  }
  if (ctx.controller.signal.aborted)
    throw ctx.cancellationError();
  if (ctx.decision.classification) {
    try {
      ctx.deps.onClassification?.({ runId: ctx.runId, sessionId: ctx.sessionId, description: ctx.request.prompt, priorContext: ctx.priorContext, classification: ctx.decision.classification });
    }
    catch (error) {
      console.error('Routing observation failed', error);
    }
  }
  ctx.emit('session:model-switched', { sessionId: ctx.sessionId, taskId: ctx.taskId, runId: ctx.runId, ...ctx.decision, role: 'routing' });
  const model = ctx.pinned ?? ctx.deps.models.getModel(ctx.decision.modelId);
  if (!model)
    throw new Error(`Routed model not found: ${ctx.decision.modelId}`);
  ctx.model = model;
}
