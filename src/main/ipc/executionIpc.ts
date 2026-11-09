import path from 'node:path';
import type { CommandExecutionRequest } from '@core/tty/CommandExecutor';
import { confirmCommand } from '../approvalPrompt';
import type { MainContext } from '../MainContext';
import { handle } from './register';
import { evaluateCommandApproval } from '@core/security/ApprovalPolicy';

export function register(ctx: MainContext): void {
  const { tty, ttyUnsubscribers, projects, workspaceRoot, commandExecutor, commandUnsubscribers } = ctx;
  handle('tty:list', () => tty.listSessions());
  handle('tty:create', async (_event, options?: { cols?: number; rows?: number }) => {
    // The renderer may choose the grid size only. Shell, cwd and env stay under
    // main-process control; otherwise a navigated page could spawn a shell with
    // the app's full environment.
    if (tty.listSessions().filter((session) => session.status === 'running').length >= 8) throw new Error('终端会话数量已达上限（8 个）');
    const cwd = projects.getRoot() ?? workspaceRoot;
    const info = await tty.createSession({ cwd, cols: options?.cols, rows: options?.rows });
    const unsubscribe = tty.onData(info.id, (data) => ctx.emit('tty:data', { sessionId: info.id, data }));
    ttyUnsubscribers.set(info.id, unsubscribe);
    return info;
  });
  handle('tty:write', (_event, id: string, data: string) => tty.write(id, data));
  handle('tty:resize', (_event, id: string, cols: number, rows: number) => tty.resize(id, cols, rows));
  handle('tty:close', (_event, id: string) => { const closed = tty.close(id); ttyUnsubscribers.get(id)?.(); ttyUnsubscribers.delete(id); return closed; });
  handle('execution:run', async (_event, request: CommandExecutionRequest) => {
    const selectedProjectRoot = projects.getRoot();
    if (!selectedProjectRoot) throw new Error('Select a project before running a command');
    if (!request || typeof request.command !== 'string' || !request.command.trim()) throw new Error('Command cannot be empty');
    const requestedCwd = request.cwd ? path.resolve(selectedProjectRoot, request.cwd) : selectedProjectRoot;
    const relative = path.relative(selectedProjectRoot, requestedCwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Working directory must stay inside the project root');
    // `approved` from the renderer is intentionally ignored. Authorization is a
    // user decision made in this process, not a boolean supplied by the page.
    if (!(await confirmCommand(ctx, request.command, requestedCwd, undefined, selectedProjectRoot))) throw new Error('用户取消了命令执行');
    // The main process is the authority for the sandbox boundary: commands run in
    // the selected project, with a filtered environment, and without renderer
    // supplied `env`/`approved` fields.
    const execution = commandExecutor.start({ command: request.command, cwd: requestedCwd, timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes, projectRoot: selectedProjectRoot, approved: true });
    const unsubscribe = commandExecutor.onData(execution.id, (event) => ctx.emit('execution:data', { executionId: execution.id, ...event }));
    commandUnsubscribers.set(execution.id, unsubscribe);
    try { return { ...await execution.promise, policy: evaluateCommandApproval(ctx.preferences.approvalMode, request.command, selectedProjectRoot, requestedCwd) }; }
    finally { unsubscribe(); commandUnsubscribers.delete(execution.id); }
  });
  handle('execution:cancel', (_event, id: unknown) => typeof id === 'string' ? commandExecutor.cancel(id) : false);
}
