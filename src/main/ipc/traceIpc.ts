import type { MainContext } from '../MainContext';
import { handle } from './register';

export function register(ctx: MainContext): void {
  const { traceRecorder, observability } = ctx;
  handle('trace:get', (_event, runId: unknown) => typeof runId === 'string' ? traceRecorder.getTrace(runId) : undefined);
  handle('trace:recent', (_event, sessionId: unknown, limit?: number) => typeof sessionId === 'string' ? traceRecorder.listRecent(sessionId, limit) : []);
  handle('trace:list', (_event, limit?: number) => traceRecorder.listRecentRuns(limit));
  handle('trace:settings:get', () => observability.getTraceRetention());
  handle('trace:settings:set', (_event, options: unknown) => {
    if (!options || typeof options !== 'object') throw new Error('Trace 保留设置无效');
    const value = options as { maxAgeDays?: unknown; maxRuns?: unknown };
    const retention = observability.setTraceRetention({
      maxAgeDays: typeof value.maxAgeDays === 'number' ? value.maxAgeDays : undefined,
      maxRuns: typeof value.maxRuns === 'number' ? value.maxRuns : undefined,
    });
    observability.pruneTraces(retention);
    return retention;
  });
  handle('trace:clear', () => observability.clearTraces());
}
