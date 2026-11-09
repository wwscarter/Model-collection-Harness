import { HookRunner, type HookRunnerOptions } from '@core/hooks/HookRunner';
import { evaluateCommandApproval } from '@core/security/ApprovalPolicy';
import type { MainContext } from './MainContext';
import { confirmCommand } from './approvalPrompt';

export type HookRuntimeContext = MainContext;
export interface HookRuntimeInput {
  projectRoot?: string;
  signal?: AbortSignal;
  assertBudget?(): void;
  onStart?: HookRunnerOptions['onStart'];
  onResult?: HookRunnerOptions['onResult'];
}

/** Load one configuration snapshot; every command keeps the host approval and sandbox path. */
export async function createHookRuntime(ctx: HookRuntimeContext, input: HookRuntimeInput = {}): Promise<{ runner: HookRunner; diagnostics: string[] }> {
  input.signal?.throwIfAborted();
  input.assertBudget?.();
  const loaded = await ctx.hookStore.load(input.projectRoot, input.signal);
  input.signal?.throwIfAborted();
  const cwd = input.projectRoot ?? ctx.workspaceRoot;
  const runner = new HookRunner({
    projectRoot: cwd, hooks: loaded.hooks, onStart: input.onStart, onResult: input.onResult,
    async execute({ command, timeoutMs, signal, shell }) {
      signal.throwIfAborted();
      input.assertBudget?.();
      const policy = evaluateCommandApproval(ctx.preferences.approvalMode, command, cwd, cwd);
      if (!(await confirmCommand(ctx, command, cwd, signal, cwd))) throw new Error('用户未批准 Hook 命令执行');
      signal.throwIfAborted();
      input.assertBudget?.();
      const result = await ctx.projectProcesses.run({ projectRoot: cwd, command, timeoutMs, signal, ...(shell ? { shell } : {}) });
      signal.throwIfAborted();
      return {
        exitCode: result.timedOut || result.cancelled ? null : result.exitCode,
        output: result.output || result.error || (result.timedOut ? 'Hook 命令执行超时' : result.cancelled ? 'Hook 命令已取消' : ''),
        sandbox: result.sandbox, policy,
      };
    },
  });
  return { runner, diagnostics: loaded.diagnostics };
}
