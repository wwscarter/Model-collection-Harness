import path from 'node:path';
import type { ProjectProcessSnapshot } from '@core/tty/ProjectProcessManager';
import { handle } from './register';
import type { MainContext } from '../MainContext';

const OUTPUT_PREVIEW_CHARS = 4_000;

export interface ProcessSummary {
  processId: string;
  pid?: number;
  sessionId?: string;
  command: string;
  cwd: string;
  status: ProjectProcessSnapshot['status'];
  running: boolean;
  urls: string[];
  exitCode: number | null;
  signal?: string;
  error?: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  sandboxEnabled: boolean;
  outputPreview: string;
}

/** The renderer gets a bounded view: no raw stdout/stderr and a short output tail. */
export function summarizeProcess(process: ProjectProcessSnapshot): ProcessSummary {
  return {
    processId: process.processId,
    ...(process.pid ? { pid: process.pid } : {}),
    ...(process.sessionId ? { sessionId: process.sessionId } : {}),
    command: process.command,
    cwd: process.cwd,
    status: process.status,
    running: process.running,
    urls: [...process.urls],
    exitCode: process.exitCode,
    ...(process.signal ? { signal: process.signal } : {}),
    ...(process.error ? { error: process.error } : {}),
    timedOut: process.timedOut,
    cancelled: process.cancelled,
    durationMs: process.durationMs,
    sandboxEnabled: process.sandbox.enabled,
    outputPreview: process.output.length > OUTPUT_PREVIEW_CHARS ? process.output.slice(-OUTPUT_PREVIEW_CHARS) : process.output,
  };
}

function projectRootOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > 4_096 || !path.isAbsolute(value)) throw new Error('项目路径无效');
  return value;
}

/** Lets the window list and stop processes the agent started, without exposing arbitrary pids. */
export function register(ctx: MainContext): void {
  handle('processes:list', (_event, projectRoot: unknown, sessionId: unknown) => {
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200)) throw new Error('会话 ID 无效');
    const root = projectRootOf(projectRoot);
    return ctx.projectProcesses.list(root).filter((process) => !sessionId || process.sessionId === sessionId).map(summarizeProcess);
  });
  handle('processes:stop', async (_event, processId: unknown, projectRoot: unknown) => {
    if (typeof processId !== 'string' || !processId || processId.length > 120) throw new Error('进程 ID 无效');
    const stopped = await ctx.projectProcesses.stop(processId, projectRootOf(projectRoot));
    try {
      ctx.operationAudit?.append({ type: 'process.stop', actor: 'user', result: 'success', command: stopped.command, ...(stopped.sessionId ? { sessionId: stopped.sessionId } : {}), detail: stopped.processId });
    } catch (error) { console.warn('[operation-audit] 记录停止进程失败', error instanceof Error ? error.message : error); }
    return summarizeProcess(stopped);
  });
}
