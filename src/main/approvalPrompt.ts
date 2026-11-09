import { dialog } from 'electron';
import { evaluateCommandApproval, evaluateToolApproval, type ToolApprovalRequest } from '@core/security/ApprovalPolicy';
import type { MainContext } from './MainContext';
import { displayPath } from './paths';

export async function approveToolCall(ctx: MainContext, { toolName, input, projectRoot }: ToolApprovalRequest): Promise<string | undefined> {
  const decision = evaluateToolApproval(ctx.preferences.approvalMode, { toolName, input, projectRoot });
  if (decision.decision === 'allow') return undefined;
  if (decision.decision === 'deny') return decision.reason;
  const mainWindow = ctx.getWindow();
  const labels: Record<string, string> = { write: '写入项目文件', edit: '编辑项目文件', run_command: input.background ? '启动后台服务' : '执行项目命令', stop_process: '停止后台服务' };
  const preview = toolName === 'run_command' ? String(input.command ?? '') : JSON.stringify(input, null, 2).slice(0, 1600);
  const detail = `${projectRoot ? `项目目录：${displayPath(projectRoot)}\n\n` : ''}${preview}${toolName === 'run_command' ? '\n\n分类：' + decision.category + '\n' + decision.reason : ''}`;
  const options = { type: 'question' as const, buttons: ['拒绝', '允许本次调用'], defaultId: 0, cancelId: 0, title: '工具调用确认', message: `模型请求${labels[toolName] ?? `调用工具「${toolName}」`}`, detail, noLink: true };
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  return response === 1 ? undefined : '用户拒绝了这次工具调用';
}

export async function confirmCommand(ctx: MainContext, command: string, cwd: string): Promise<boolean> {
  const decision = evaluateCommandApproval(ctx.preferences.approvalMode, command, ctx.projects.getRoot() ?? cwd, cwd);
  if (decision.decision === 'allow') return true;
  if (decision.decision === 'deny') return false;
  const mainWindow = ctx.getWindow();
  const options = {
    type: 'warning' as const,
    buttons: ['取消', '执行命令'],
    defaultId: 0,
    cancelId: 0,
    title: '命令执行确认',
    message: '模型或终端请求执行一条本地命令',
    detail: `工作目录：${displayPath(cwd)}\n\n${command.slice(0, 4000)}${command.length > 4000 ? '\n…（已截断）' : ''}\n\n分类：${decision.category}\n${decision.reason}`,
    noLink: true,
  };
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  return response === 1;
}

