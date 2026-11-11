import { randomUUID } from 'node:crypto';
import type { SessionRecord } from '@core/storage/SessionStorage';
import { executeRun, type RunRequest } from '@core/agent/RunCoordinator';
import { createRunProjectContext } from '@core/project/RunProjectContext';
import { createRunDependencies } from '../runDependencies';
import type { MainContext } from '../MainContext';
import { handle } from './register';
import { planningMode, type PlanDecision } from '@core/planning/PlanTypes';
import { restoreSessionMedia } from '../mediaSession';

export function register(ctx: MainContext): void {
  const { sessionStorage, projectStorage, runningTasks } = ctx;
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
  handle('session:save', (_event, session: SessionRecord) => {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !session.id) throw new Error('会话数据无效');
    return sessionStorage.save({ ...session, createdAt: session.createdAt ? new Date(session.createdAt) : new Date(), updatedAt: session.updatedAt ? new Date(session.updatedAt) : new Date() });
  });
  handle('session:delete', async (_event, id: unknown) => {
    if (typeof id !== 'string') return { success: false };
    runningTasks.get(id)?.abort();
    await ctx.media?.deleteSession(id);
    ctx.plans?.deleteSession(id);
    return { success: sessionStorage.delete(id) };
  });
  handle('session:execute', async (_event, payload: RunRequest) => {
    if (ctx.shuttingDown) throw new Error('应用正在关闭，无法开始新任务');
    if (!payload || typeof payload.prompt !== 'string' || !payload.prompt.trim()) throw new Error('任务描述不能为空');
    if (payload.prompt.length > 200_000) throw new Error('任务描述过长');
    if (payload.planningMode !== undefined) planningMode(payload.planningMode);
    if (payload.sessionId !== undefined && typeof payload.sessionId !== 'string') throw new Error('会话 ID 无效');
    if (payload.taskId !== undefined && typeof payload.taskId !== 'string') throw new Error('任务 ID 无效');
    const sessionId = payload.sessionId || payload.taskId || randomUUID();
    const request: RunRequest = { ...payload, sessionId };
    const projectContext = createRunProjectContext(
      payload.projectId === undefined ? sessionStorage.get(sessionId)?.projectId : payload.projectId,
      projectStorage,
    );
    const controller = new AbortController();
    runningTasks.get(sessionId)?.abort();
    runningTasks.set(sessionId, controller);
    let operation: Promise<Record<string, unknown>> | undefined;
    try {
      operation = executeRun(request, createRunDependencies(ctx, controller, projectContext), ctx.emit);
      ctx.runningOperations?.add(operation);
      return await operation;
    } finally {
      if (operation) ctx.runningOperations?.delete(operation);
      if (runningTasks.get(sessionId) === controller) runningTasks.delete(sessionId);
    }
  });
  handle('session:cancel', (_event, taskId: unknown) => {
    if (typeof taskId !== 'string') return { success: false };
    runningTasks.get(taskId)?.abort();
    return { success: runningTasks.has(taskId) };
  });
}
