import { randomUUID } from 'node:crypto';
import { executeRun, type RunRequest } from '@core/agent/RunCoordinator';
import { createRunProjectContext } from '@core/project/RunProjectContext';
import { createRunDependencies } from '../runDependencies';
import type { MainContext } from '../MainContext';
import { handle } from './register';
import type { PlanDecision } from '@core/planning/PlanTypes';
import { restoreSessionMedia } from '../mediaSession';
import { validateRunRequest, validateSessionRecord } from './sessionPayloads';
import { RateLimiter } from './rateLimit';

/** How long a new run waits for the aborted run of the same session to release its files. */
const PREVIOUS_RUN_SETTLE_MS = 10_000;

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function register(ctx: MainContext): void {
  const { sessionStorage, projectStorage, runningTasks } = ctx;
  // One active run per session: aborting the previous run is not enough because
  // abort settles asynchronously, and two overlapping runs would interleave
  // file writes in the same project.
  const activeRuns = new Map<string, Promise<unknown>>();
  const executeLimiter = new RateLimiter({ limit: 20, windowMs: 60_000 });
  handle('session:list', () => sessionStorage.list());
  handle('session:get', (_event, id: string) => restoreSessionMedia(sessionStorage.get(id), ctx.media));
  handle('session:plans-list', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('会话 ID 无效');
    return ctx.plans?.list(sessionId) ?? [];
  });
  handle('session:plan-decision', (_event, decision: PlanDecision) => {
    if (!ctx.plans) throw new Error('计划确认服务不可用');
    return ctx.plans.decide(decision);
  });
  handle('session:save', (_event, session: unknown) => sessionStorage.save(validateSessionRecord(session)));
  handle('session:delete', async (_event, id: unknown) => {
    if (typeof id !== 'string') return { success: false };
    runningTasks.get(id)?.abort();
    await ctx.media?.deleteSession(id);
    ctx.plans?.deleteSession(id);
    return { success: sessionStorage.delete(id) };
  });
  handle('session:execute', async (_event, payload: unknown) => {
    if (ctx.shuttingDown) throw new Error('应用正在关闭，无法开始新任务');
    const request = validateRunRequest(payload);
    if (!request.prompt.trim()) throw new Error('任务描述不能为空');
    const sender = `execute:${_event.sender?.id ?? 'unknown'}`;
    if (!executeLimiter.allow(sender)) {
      const retry = executeLimiter.retryAfterSeconds(sender) || 1;
      throw new Error(`任务提交过于频繁（每分钟最多 20 次），请在 ${retry} 秒后重试`);
    }
    const sessionId = request.sessionId || request.taskId || randomUUID();
    const waitStartedAt = Date.now();
    while (activeRuns.has(sessionId) && Date.now() - waitStartedAt < PREVIOUS_RUN_SETTLE_MS) {
      const active = activeRuns.get(sessionId)!;
      runningTasks.get(sessionId)?.abort();
      await settleWithin(active, PREVIOUS_RUN_SETTLE_MS - (Date.now() - waitStartedAt));
    }
    if (ctx.shuttingDown) throw new Error('应用正在关闭，无法开始新任务');
    const projectContext = createRunProjectContext(
      request.projectId === undefined ? sessionStorage.get(sessionId)?.projectId : request.projectId,
      projectStorage,
    );
    const runRequest: RunRequest = { ...request, sessionId };
    const controller = new AbortController();
    runningTasks.get(sessionId)?.abort();
    runningTasks.set(sessionId, controller);
    let operation: Promise<Record<string, unknown>> | undefined;
    try {
      operation = executeRun(runRequest, createRunDependencies(ctx, controller, projectContext), ctx.emit);
      activeRuns.set(sessionId, operation);
      ctx.runningOperations?.add(operation);
      return await operation;
    } finally {
      if (operation) ctx.runningOperations?.delete(operation);
      if (activeRuns.get(sessionId) === operation) activeRuns.delete(sessionId);
      if (runningTasks.get(sessionId) === controller) runningTasks.delete(sessionId);
    }
  });
  handle('session:cancel', (_event, taskId: unknown) => {
    if (typeof taskId !== 'string') return { success: false };
    runningTasks.get(taskId)?.abort();
    return { success: runningTasks.has(taskId) };
  });
}
