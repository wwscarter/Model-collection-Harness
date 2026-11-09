import fs from 'node:fs';
import path from 'node:path';

export type ApprovalMode = 'ask' | 'auto' | 'full';
export interface ApprovalDecision { decision: 'allow' | 'confirm' | 'deny'; reason: string }
export interface ToolApprovalRequest { toolName: string; input: Record<string, unknown>; projectRoot?: string }

export const SAFE_TOOLS = new Set(['web_search', 'web_fetch', 'read', 'ls', 'grep', 'find', 'code_symbols', 'code_search', 'process_status', 'process_list', 'remember', 'recall']);

export function isDangerousCommand(command: string): boolean {
  return /(^|[;&|]\s*)(sudo|su|shutdown|reboot|diskutil|mkfs|dd\s+if=|rm\s+-rf\s+\/|chmod\s+-R\s+777|:?\(\)\s*\{)/i.test(command)
    || /(curl|wget)[^|]*\|\s*(ba|z|da)?sh/i.test(command);
}

export function loadApprovalMode(file: string): ApprovalMode {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { approvalMode?: unknown };
    return value.approvalMode === 'auto' || value.approvalMode === 'full' ? value.approvalMode : 'ask';
  } catch { return 'ask'; }
}

export function savePreferences(preferencesPath: string, nextApprovalMode: ApprovalMode): void {
  const temporary = `${preferencesPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ approvalMode: nextApprovalMode }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, preferencesPath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the original error */ }
    throw new Error(`设置保存失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The native host owns confirmation; this module only chooses the policy result. */
export function evaluateCommandApproval(mode: ApprovalMode, command: string): ApprovalDecision {
  if (mode === 'full' || (mode === 'auto' && !isDangerousCommand(command))) {
    return { decision: 'allow', reason: '当前权限模式允许本次命令' };
  }
  return { decision: 'confirm', reason: '本次命令需要用户确认' };
}

export function evaluateToolApproval(mode: ApprovalMode, request: ToolApprovalRequest): ApprovalDecision {
  if (SAFE_TOOLS.has(request.toolName)) return { decision: 'allow', reason: '只读或安全工具' };
  if (request.toolName === 'run_command') return evaluateCommandApproval(mode, String(request.input.command ?? ''));
  return mode === 'ask'
    ? { decision: 'confirm', reason: '本次工具调用需要用户确认' }
    : { decision: 'allow', reason: '当前权限模式允许本次工具调用' };
}
