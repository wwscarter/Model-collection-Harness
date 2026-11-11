import { handle } from './register';
import type { MainContext } from '../MainContext';

const RUN_ID = /^[a-zA-Z0-9_-]{1,120}$/;

/** Read-only progress lookup plus acknowledgement of an interrupted run. */
export function register(ctx: MainContext): void {
  handle('checkpoints:latest', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('会话 ID 无效');
    return ctx.checkpoints?.latest(sessionId);
  });
  handle('checkpoints:acknowledge', (_event, runId: unknown) => {
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('运行 ID 无效');
    ctx.checkpoints?.acknowledge(runId);
    return { success: true };
  });
}
