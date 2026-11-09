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

export type { InvokeStreamed, RunDependencies, RunEmit, RunRequest } from './run/RunTypes';

/** Execute one user turn through independently testable pipeline stages. */
export async function executeRun(request: RunRequest, deps: RunDependencies, emit: RunEmit): Promise<Record<string, unknown>> {
  const ctx = createRunContext(request, deps, emit);
  let output: Record<string, unknown>;
  try {
    await startHooks(ctx);
    await contextStage(ctx);
    await routeStage(ctx);
    await planStage(ctx);
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
  } catch (error) {
    const failure = ctx.controller.signal.aborted ? ctx.cancellationError() : error;
    ctx.traceStatus = failure instanceof Error && failure.message === '任务已取消' ? 'cancelled' : 'failed';
    ctx.traceError = failure instanceof Error ? failure.message : String(failure);
    throw failure;
  } finally {
    await endHooks(ctx);
    clearTimeout(ctx.deadlineTimer);
    ctx.finishTrace(ctx.traceStatus, ctx.traceError);
  }
  ctx.emit('session:completed', output);
  return output;
}
