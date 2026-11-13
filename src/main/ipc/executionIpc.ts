import path from 'node:path';
import type { CommandExecutionRequest } from '@core/tty/CommandExecutor';
import { confirmCommand } from '../approvalPrompt';
import type { MainContext } from '../MainContext';
import { handle } from './register';
import { evaluateCommandApproval } from '@core/security/ApprovalPolicy';

export function register(ctx: MainContext): void {
  const { projects, commandExecutor, commandUnsubscribers } = ctx;
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
