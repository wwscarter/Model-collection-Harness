import { app, dialog, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createCredentialCodec, createElectronSafeStorageKeyProvider } from '@utils/crypto';
import { createCore, type CoreApprovalRequest } from '@core/bootstrap/createCore';
import { TtyManager } from '@core/tty/TtyManager';
import { approveToolCall, confirmCommand } from './approvalPrompt';
import { appendMcpLog } from './mcpRuntime';
import type { MainContext } from './MainContext';

/** Electron contributes native approval and keyring adapters to the shared core. */
export async function createMainContext(dataDir: string, getWindow: MainContext['getWindow']): Promise<MainContext> {
  let ctx: MainContext | undefined;
  const keyProvider = process.env.AMD_ENCRYPTION_KEY
    ? () => process.env.AMD_ENCRYPTION_KEY!
    : createElectronSafeStorageKeyProvider({ keyPath: path.join(dataDir, 'credentials.key'), safeStorage });
  const core = await createCore({
    dataDir,
    credentialCodec: createCredentialCodec(keyProvider),
    emit: (channel, payload) => getWindow()?.webContents.send(channel, payload),
    confirm: (request) => confirmNativeRequest(ctx!, request),
    onMcpStderr: (entry, text) => { if (ctx) appendMcpLog(ctx, entry, text); },
  });
  try {
    const tty = new TtyManager({ defaultCwd: core.workspaceRoot });
    // Keep host state on the shared core so IPC replacements are visible to the next run.
    ctx = Object.assign(core, { core, getWindow, tty, ttyUnsubscribers: new Map<string, () => void>(), commandUnsubscribers: new Map<string, () => void>(), pickedProjectRoots: new Set<string>(), runningOperations: new Set<Promise<unknown>>() });
    return ctx;
  } catch (error) { await core.dispose(); throw error; }
}

async function confirmNativeRequest(ctx: MainContext, request: CoreApprovalRequest): Promise<boolean> {
  request.signal?.throwIfAborted();
  if (request.kind === 'tool') return (await approveToolCall(ctx, request)) === undefined;
  if (request.kind === 'command') return confirmCommand(ctx, request.command, request.cwd, request.signal, request.projectRoot);
  const isPlan = request.kind === 'plan';
  const detail = isPlan
    ? request.plan.plan.steps.map((step, index) => (index + 1) + '. ' + step.title + (step.detail ? '：' + step.detail : '')).join('\n')
    : '项目：' + request.projectRoot + '\n\n' + request.commands.map((command) => (command.phase === 'quick' ? '快速' : '完整') + ' · ' + command.label + '\n' + command.command).join('\n\n') + '\n\n修改测试文件时也会运行测试。确认的命令保存在：\n' + request.configPath;
  const options = { type: 'question' as const, signal: request.signal, title: isPlan ? '确认执行计划' : '确认项目验证命令', message: isPlan ? '按照以下计划执行？' : '允许在修改项目文件后运行以下检查？', detail, buttons: isPlan ? ['取消', '执行'] : ['本轮跳过', '确认并运行'], defaultId: 0, cancelId: 0, noLink: true };
  const window = ctx.getWindow();
  const answer = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  request.signal?.throwIfAborted();
  return answer.response === 1;
}

const disposingContexts = new WeakMap<MainContext, Promise<void>>();
export function disposeMainContext(ctx: MainContext): Promise<void> {
  const existing = disposingContexts.get(ctx);
  if (existing) return existing;
  ctx.shuttingDown = true;
  for (const controller of ctx.runningTasks.values()) controller.abort();
  ctx.tty.dispose();
  for (const unsubscribe of [...ctx.ttyUnsubscribers.values(), ...ctx.commandUnsubscribers.values()]) unsubscribe();
  const disposal = (async () => {
    await Promise.allSettled([...(ctx.runningOperations ?? [])]);
    if (ctx.core) { await ctx.core.dispose(); return; }
    ctx.routingService.dispose(); ctx.commandExecutor.dispose(); ctx.projectProcesses.dispose();
    ctx.codebase.dispose(); ctx.semanticSearch.close(); ctx.storage.close(); ctx.sessionStorage.close();
    ctx.projectStorage.close(); ctx.observability.close(); ctx.memoryStore.close();
  })();
  disposingContexts.set(ctx, disposal);
  return disposal;
}

export function showCredentialWarning(ctx: MainContext): void {
  if (process.env.AMD_ENCRYPTION_KEY || safeStorage.isEncryptionAvailable()) return;
  const options = {
    type: 'warning' as const,
    title: '系统密钥库不可用',
    message: '无法使用系统密钥库加密 API Key',
    detail: '应用仍可启动，但已保存的凭据无法解密，新凭据也无法保存。请检查系统钥匙串，或设置 AMD_ENCRYPTION_KEY 后重新启动。损坏的模型会显示“需重新输入”。',
    buttons: ['知道了'],
  };
  const mainWindow = ctx.getWindow();
  if (mainWindow) void dialog.showMessageBox(mainWindow, options); else void dialog.showMessageBox(options);
}

/** Keep the failure visible and recoverable instead of quitting with only a console line. */
export function reportStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'startup-error.log'), `${new Date().toISOString()}\n${error instanceof Error ? error.stack ?? message : message}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* best effort */ }
  console.error('AMD Agent failed to start', error);
  try { dialog.showErrorBox('newAi 启动失败', `${message}\n\n诊断日志：${path.join(app.getPath('userData'), 'startup-error.log')}`); } catch { /* dialog is best effort */ }
  app.quit();
}

