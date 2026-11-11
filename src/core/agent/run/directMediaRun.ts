import { randomUUID } from 'node:crypto';
import { supportsOperation } from '@core/models/ModelOperations';
import { snapshotModel } from '@core/models/ModelSnapshot';
import { normalizeMediaRequest, routeMediaRequest } from '@core/media/MediaRouting';
import type { MediaOperation, MediaRequest } from '@core/media/MediaTypes';
import { RunBudget } from '@core/routing/RunBudget';
import { DEFAULT_ROUTING_SETTINGS } from '@core/routing/RoutingSettings';
import { PlanController } from '@core/planning/PlanController';
import { planningMode } from '@core/planning/PlanTypes';
import type { RunDependencies, RunEmit, RunRequest } from './RunTypes';
import { createMediaObserver } from './mediaObservation';

/** Pure media requests share the same service as agent tools, without a text-model call. */
export async function executeDirectMedia(request: RunRequest, operation: MediaOperation, deps: RunDependencies, emit: RunEmit): Promise<Record<string, unknown>> {
  if (!deps.media) throw new Error('媒体生成服务不可用');
  if (request.enableTools === false) throw new Error('本轮已禁用工具，无法执行媒体生成');
  const sessionId = request.sessionId ?? request.taskId ?? randomUUID(), runId = request.runId ?? randomUUID();
  const assistantMessageId = request.assistantMessageId ?? runId + '-assistant';
  const identity = { sessionId, taskId: request.taskId ?? sessionId, runId, assistantMessageId };
  const input: MediaRequest = normalizeMediaRequest({ ...request.media, operation, prompt: request.prompt, artifactSlot: 'direct' });
  const allModels = deps.models.getAllModels();
  if (request.pinnedModelId && !allModels.some((model) => model.id === request.pinnedModelId && supportsOperation(model, operation))) throw new Error('MODEL_OPERATION_MISMATCH：指定模型不支持本轮媒体操作');
  const candidates = routeMediaRequest(input, allModels.filter((model) => (!request.pinnedModelId || model.id === request.pinnedModelId) && deps.quota.isAvailable(model)));
  const selected = candidates[0];
  const trace = deps.traces.startRun({ runId, sessionId, taskType: operation });
  const observeMedia = createMediaObserver(deps, trace, runId);
  const limits = deps.routingSettings?.budget ?? DEFAULT_ROUTING_SETTINGS.budget!;
  const budget = new RunBudget({ maxCost: limits.maxCostUsd, maxDurationMs: limits.maxDurationMs });
  const abort = new AbortController();
  const signal = AbortSignal.any([deps.controller.signal, abort.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let costStatus = 'estimated', totalCost = 0;
  const reservations = new Map<string, number>(), settled = new Set<string>();
  let status: 'success' | 'failed' | 'cancelled' = 'failed', errorMessage: string | undefined;
  let planCreated = false;
  const plans = deps.plans ?? new PlanController();
  const outputBase = { ...identity, modelUsed: { id: selected.model.id, name: selected.model.name, modelId: selected.model.modelId }, decision: { modelId: selected.model.id, operation, reason: selected.reason, confidence: 1, alternativeModels: candidates.slice(1).map((candidate) => candidate.model.id) } };
  try {
    trace.child('route', 'media.route', { operation, modelId: selected.model.id, modelSnapshot: snapshotModel(selected.model), candidates: candidates.map((c) => c.model.id), reason: selected.reason }).end();
    emit('session:model-switched', { ...identity, modelId: selected.model.id, role: 'routing', confidence: 1, reason: selected.reason, operation });
    const mode = planningMode(request.planningMode ?? deps.routingSettings?.planning.executionMode ?? 'auto');
    if (mode !== 'auto') {
      const plan = plans.create({ ...identity, editable: false, executionMode: mode, status: mode === 'confirm' ? 'awaiting' : 'ready', plan: {
        mode: 'direct', taskType: 'creative', complexity: 'medium', subagents: [], verify: false,
        steps: [{ id: 'media-generate', title: operation === 'image.generate' ? '生成图片并保存' : '生成视频并保存', detail: request.prompt + '\n候选模型：' + selected.model.name + '\n单次预估：' + (selected.estimatedCostUsd === undefined ? '未配置' : '$' + selected.estimatedCostUsd), status: 'pending' }],
      } });
      planCreated = true;
      if (mode === 'only') {
        emit('session:plan', plan);
        status = 'success'; plans.status(runId, 'completed', (current) => emit('session:plan', current));
        const result = { ...outputBase, output: plan.plan.steps[0].detail, plan, stopReason: 'plan_only', artifacts: [], metrics: { inputTokens: 0, outputTokens: 0, totalCost: 0 } };
        emit('session:completed', result); return result;
      }
      budget.pause();
      try { await plans.wait(plan, signal, (current) => emit('session:plan', current)); } finally { budget.resume(); }
      plans.status(runId, 'executing', (current) => emit('session:plan', current));
    }
    const denial = await deps.approveMedia?.({ operation, prompt: request.prompt }, signal);
    signal.throwIfAborted();
    if (denial) throw new Error(denial);
    timer = setTimeout(() => abort.abort(new Error('媒体生成已超过本轮时间预算，未收到的结果状态未知')), limits.maxDurationMs);
    timer.unref?.();
    const result = await deps.media.execute(input, {
      rootRunId: runId, sessionId, assistantMessageId, modelId: request.pinnedModelId, signal, quota: deps.quota,
      budget: {
        reserve(id, estimate) {
          if (estimate === undefined) throw new Error('请在模型与端点中配置媒体单次预估费用');
          budget.assertAvailable([...reservations.values()].reduce((a, b) => a + b, 0) + estimate);
          reservations.set(id, estimate);
        },
        settle(id, cost) {
          if (settled.has(id)) return;
          settled.add(id);
          const charged = cost ?? reservations.get(id) ?? 0;
          if (cost === undefined) costStatus = 'unknown';
          budget.add({ cost: charged }); totalCost += charged; reservations.delete(id);
        },
      },
      onJob(job) {
        if (job.status === 'unknown') costStatus = 'unknown';
        else if (job.status === 'succeeded') costStatus = job.costStatus;
        observeMedia(job);
        emit('session:media-job', { ...identity, job });
        if (job.artifacts.length) emit('session:media-artifact', { ...identity, artifacts: job.artifacts });
      },
    });
    const attempt = result.job.attempts.at(-1)!;
    status = 'success';
    if (planCreated) plans.status(runId, 'completed', (current) => emit('session:plan', current));
    const output = { ...outputBase, modelUsed: { id: attempt.configurationId, name: deps.models.getModel(attempt.configurationId)?.name ?? attempt.modelId, modelId: attempt.modelId }, output: '图片已生成并保存。', stopReason: 'stop', artifacts: result.artifacts, mediaJobs: [result.job], metrics: { inputTokens: 0, outputTokens: 0, totalCost, costStatus, latency: budget.snapshot().elapsedMs } };
    emit('session:completed', output); return output;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    status = deps.controller.signal.aborted ? 'cancelled' : 'failed';
    if (planCreated) plans.status(runId, status === 'cancelled' ? 'cancelled' : 'failed', (current) => emit('session:plan', current));
    throw error;
  } finally {
    clearTimeout(timer);
    deps.traces.finishRun(runId, { status, error: errorMessage, inputTokens: 0, outputTokens: 0, cost: totalCost });
  }
}
