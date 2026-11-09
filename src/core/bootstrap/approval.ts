import { evaluateCommandApproval, evaluateToolApproval, type ToolApprovalRequest } from '@core/security/ApprovalPolicy';
import { MODE_CONTROLLED_TOOLS } from '@core/security/ToolTrustStore';
import type { CoreServices } from './CoreTypes';

export async function approveCoreTool(ctx: CoreServices, request: ToolApprovalRequest): Promise<string | undefined> {
  const trust = ctx.toolTrust.get(request.toolName);
  if (trust === 'disabled') return '工具已在信任设置中禁用：' + request.toolName;
  if (trust === 'auto' && !MODE_CONTROLLED_TOOLS.has(request.toolName)) return undefined;
  const decision = evaluateToolApproval(ctx.preferences.approvalMode, request);
  if (decision.decision === 'deny') return decision.reason;
  if (trust !== 'ask' && decision.decision === 'allow') return undefined;
  return await ctx.host.confirm({ kind: 'tool', ...request, decision }) ? undefined : '用户拒绝了这次工具调用';
}

export async function confirmCoreCommand(ctx: CoreServices, command: string, cwd: string, signal?: AbortSignal, projectRoot = cwd): Promise<boolean> {
  signal?.throwIfAborted();
  const decision = evaluateCommandApproval(ctx.preferences.approvalMode, command, projectRoot, cwd);
  if (decision.decision === 'allow') return true;
  if (decision.decision === 'deny') return false;
  const approved = await ctx.host.confirm({ kind: 'command', command, cwd, projectRoot, decision, signal });
  signal?.throwIfAborted();
  return approved;
}
