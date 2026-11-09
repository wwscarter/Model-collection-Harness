import fs from 'node:fs';
import path from 'node:path';
import { classifyCommand, type CommandCategory } from './CommandPolicy';

export type ApprovalMode = 'ask' | 'auto' | 'full';
export interface ApprovalDecision { decision: 'allow' | 'confirm' | 'deny'; reason: string; category?: CommandCategory; outsideProject?: boolean }
export interface ToolApprovalRequest { toolName: string; input: Record<string, unknown>; projectRoot?: string }

export const SAFE_TOOLS = new Set(['web_search', 'web_fetch', 'read', 'ls', 'grep', 'find', 'code_symbols', 'code_search', 'process_status', 'process_list', 'remember', 'recall']);

export function isDangerousCommand(command: string, projectRoot?: string): boolean {
  const assessment = classifyCommand(command, projectRoot);
  return ['escalate', 'opaque', 'network'].includes(assessment.category) || (assessment.category === 'write' && assessment.outsideProject);
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
export function evaluateCommandApproval(mode: ApprovalMode, command: string, projectRoot?: string, cwd?: string): ApprovalDecision {
  const assessment = classifyCommand(command, projectRoot, cwd);
  const administrative = assessment.category === 'escalate';
  const automatic = ['read', 'build'].includes(assessment.category) || (assessment.category === 'write' && !assessment.outsideProject);
  const allow = !administrative && (mode === 'full' || (mode === 'auto' && automatic));
  return {
    decision: allow ? 'allow' : 'confirm', category: assessment.category, outsideProject: assessment.outsideProject,
    reason: administrative ? '行政或系统级命令始终需要确认' : allow ? '当前权限模式允许本次命令' : '本次命令需要用户确认：' + assessment.reasons.join('；'),
  };
}

export function evaluateToolApproval(mode: ApprovalMode, request: ToolApprovalRequest): ApprovalDecision {
  if (request.toolName === 'update_plan') return { decision: 'allow', reason: '更新当前计划的步骤进度' };
  if (SAFE_TOOLS.has(request.toolName)) return { decision: 'allow', reason: '只读或安全工具' };
  if (request.toolName === 'run_command') return evaluateCommandApproval(mode, String(request.input.command ?? ''), request.projectRoot);
  return mode === 'ask'
    ? { decision: 'confirm', reason: '本次工具调用需要用户确认' }
    : { decision: 'allow', reason: '当前权限模式允许本次工具调用' };
}
