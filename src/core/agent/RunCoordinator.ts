import { BudgetExceededError } from '@core/routing/RunBudget';
import { compactStage } from './run/compactStage';
import { contextStage } from './run/contextStage';
import { executeStage } from './run/executeStage';
import { finalizeStage } from './run/finalizeStage';
import { endHooks, startHooks } from './run/hookLifecycle';
import { parallelStage } from './run/parallelStage';
import { planStage } from './run/planStage';
import { routeStage } from './run/routeStage';
import { createRunContext } from './run/RunContext';
import type { RunDependencies, RunEmit, RunRequest } from './run/RunTypes';
import { verifyStage } from './run/verifyStage';
import { resolveRequestOperation } from '@core/routing/RequestOperation';
import { executeDirectMedia } from './run/directMediaRun';
import { validateSessionRules } from './sessionRules';

export type { InvokeStreamed, RunDependencies, RunEmit, RunRequest } from './run/RunTypes';

/** Execute one user turn through independently testable pipeline stages. */
export async function executeRun(request: RunRequest, deps: RunDependencies, emit: RunEmit): Promise<Record<string, unknown>> {
  if (!request || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 200_000) throw new Error('任务描述无效');
  for (const key of ['sessionId', 'taskId', 'runId', 'assistantMessageId', 'pinnedModelId', 'textModelPreferenceId'] as const) {
    if (request[key] !== undefined && (typeof request[key] !== 'string' || !request[key]?.trim() || request[key]!.length > 300)) throw new Error('无效的请求身份字段：' + key);
  }
  validateSessionRules(request.sessionRules);
  const operation = resolveRequestOperation(request.prompt, request.operation);
  if (operation !== 'text.chat') return executeDirectMedia(request, operation, deps, emit);
  const ctx = createRunContext(request, deps, emit);
  try { deps.checkpoints?.start({ runId: ctx.runId, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), prompt: request.prompt }); }
  catch (error) { console.warn('[checkpoint] 记录任务开始失败', error instanceof Error ? error.message : error); }
  let output: Record<string, unknown>;
  try {
    await contextStage(ctx);
    await routeStage(ctx);
    await planStage(ctx);
    if (ctx.planOnlyOutput) {
      output = ctx.planOnlyOutput;
    } else {
      await startHooks(ctx);
      await compactStage(ctx);
      try {
        await parallelStage(ctx);
        await executeStage(ctx);
        await verifyStage(ctx);
        output = await finalizeStage(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.executionSpan?.end({ status: message === '任务已取消' ? 'cancelled' : 'failed', error: message });
        ctx.synthesisSpan?.end({ status: 'failed', error: message });
        // Failures are learning signals too; user cancellations are not model failures.
        if (!ctx.controller.signal.aborted && !(error instanceof BudgetExceededError)) {
          ctx.recordGrowth({ modelId: ctx.executionModel.id, taskType: ctx.decision.taskType, success: false, completed: false, actualLatency: ctx.metrics?.latency });
        }
        throw error;
      }
    }
    if (ctx.runPlan && !ctx.planOnlyOutput) ctx.plans.status(ctx.runId, ctx.traceStatus === 'success' ? 'completed' : 'failed', (plan) => { ctx.runPlan = plan; ctx.emit('session:plan', plan); });
  } catch (error) {
    const failure = ctx.controller.signal.aborted ? ctx.cancellationError() : error;
    ctx.traceStatus = failure instanceof Error && failure.message === '任务已取消' ? 'cancelled' : 'failed';
    ctx.traceError = failure instanceof Error ? failure.message : String(failure);
    if (ctx.runPlan && ctx.runPlan.status !== 'cancelled') ctx.plans.status(ctx.runId, ctx.traceStatus === 'cancelled' ? 'cancelled' : 'failed', (plan) => ctx.emit('session:plan', plan));
    throw failure;
  } finally {
    try { deps.checkpoints?.finish(ctx.runId, ctx.traceStatus === 'cancelled' ? 'cancelled' : ctx.traceStatus === 'failed' ? 'failed' : 'completed'); }
    catch (error) { console.warn('[checkpoint] 记录任务结束失败', error instanceof Error ? error.message : error); }
    await endHooks(ctx);
    clearTimeout(ctx.deadlineTimer);
    ctx.finishTrace(ctx.traceStatus, ctx.traceError);
  }
  ctx.emit('session:completed', output);
  return output;
}
