import { hasUsableCredentials } from '@core/models/ModelConfig';
import type { RunDependencies } from '@core/agent/RunCoordinator';
import { HookRunner } from '@core/hooks/HookRunner';
import { evaluateCommandApproval } from '@core/security/ApprovalPolicy';
import { VerificationLoop } from '@core/verify/VerificationLoop';
import { resolveVerifyCommands } from '@core/verify/VerifyCommandResolver';
import { selectVerifyCommands } from '@core/verify/VerifyCommandSelection';
import { confirmProjectVerifyConfig, defaultVerifyConfig, loadProjectVerifyConfig, projectVerifyConfigPath } from '@core/verify/ProjectVerifyConfig';
import type { ProjectVerifyConfig } from '@core/verify/VerificationTypes';
import type { CoreServices } from './CoreTypes';
import { confirmCoreCommand } from './approval';

const estimateTokens = (value: string) => Math.max(1, Math.ceil(value.length / 4));

export function createCoreRunDependencies(ctx: CoreServices, controller: AbortController, projectContext: RunDependencies['projectContext'] = ctx.projects): RunDependencies {
  return {
    models: ctx.registry, routing: ctx.routingPolicy, routingSettings: ctx.routingService.getConfiguration().settings,
    onClassification: (observation) => ctx.routingLearning.observe(observation),
    quota: ctx.modelQuota, traces: ctx.traceRecorder, observability: ctx.observability, growth: ctx.growth,
    codeAuditor: ctx.codeAuditor, auditLog: ctx.auditLog, memory: ctx.memoryStore, summaries: ctx.sessionStorage,
    projectContext, controller, plans: ctx.plans,
    ...(ctx.options.createProvider ? { createProvider: ctx.options.createProvider } : {}),
    invokeStreamed: ctx.options.invokeStreamed ?? (async (model, prompt, maxTokens, onDelta, options = {}) => {
      options.signal?.throwIfAborted();
      if (!hasUsableCredentials(model)) throw new Error(`模型「${model.name}」尚未配置 API Key，无法执行任务`);
      const changedPaths = new Map<string, string>();
      const result = await ctx.agentRuntime.run({
        model, prompt, history: options.history, summary: options.summary, skipHistoryTrim: options.skipHistoryTrim,
        maxTokens: Math.min(model.maxTokens ?? maxTokens, maxTokens), enableTools: options.enableTools !== false,
        projectRoot: options.projectRoot, projectAccess: options.projectAccess, signal: options.signal, onTextDelta: onDelta,
        sessionRules: options.sessionRules, rulesLoader: ctx.rulesLoader, onRulesLoaded: options.onRulesLoaded, hookRunner: options.hookRunner, planTool: options.planTool,
        onToolEvent(event) {
          if (['write', 'edit'].includes(event.toolName)) {
            const file = (event.args as { path?: unknown } | undefined)?.path;
            if (event.status === 'running' && typeof file === 'string') changedPaths.set(event.toolCallId, file);
            const changed = changedPaths.get(event.toolCallId);
            if (event.status !== 'running') {
              changedPaths.delete(event.toolCallId);
              if (event.status === 'completed' && changed && options.projectRoot) {
                void ctx.codebase.refresh(options.projectRoot, [changed], options.signal).catch((error) => {
                  if (!options.signal?.aborted) console.warn('代码符号增量更新失败', error);
                });
              }
            }
          }
          options.onToolEvent?.(event);
        },
        beforeModelRequest: options.beforeModelRequest, onUsage: options.onUsage, afterTurn: options.afterTurn,
      });
      return { content: result.content, inputTokens: result.inputTokens ?? estimateTokens(prompt), outputTokens: result.outputTokens ?? estimateTokens(result.content), modelId: model.id, stopReason: result.stopReason, budgetLimitReason: result.budgetLimitReason };
    }),
    createHookRuntime: async (input) => {
      input.signal.throwIfAborted(); input.assertBudget();
      const loaded = await ctx.hookStore.load(input.projectRoot, input.signal);
      input.signal.throwIfAborted();
      const cwd = input.projectRoot ?? ctx.workspaceRoot;
      const runner = new HookRunner({
        projectRoot: cwd, hooks: loaded.hooks, onStart: input.onStart, onResult: input.onResult,
        async execute({ command, timeoutMs, signal, shell }) {
          signal.throwIfAborted(); input.assertBudget();
          const policy = evaluateCommandApproval(ctx.preferences.approvalMode, command, cwd, cwd);
          if (!(await confirmCoreCommand(ctx, command, cwd, signal))) throw new Error('用户未批准 Hook 命令执行');
          signal.throwIfAborted(); input.assertBudget();
          const result = await ctx.projectProcesses.run({ projectRoot: cwd, command, timeoutMs, signal, ...(shell ? { shell } : {}) });
          signal.throwIfAborted();
          return { exitCode: result.timedOut || result.cancelled ? null : result.exitCode, output: result.output || result.error || (result.timedOut ? 'Hook 命令执行超时' : result.cancelled ? 'Hook 命令已取消' : ''), sandbox: result.sandbox, policy };
        },
      });
      return { runner, diagnostics: loaded.diagnostics };
    },
    createProjectVerification: (input) => {
      const initiallyApproved = new Set<string>();
      let activeConfig: ProjectVerifyConfig | undefined;
      return new VerificationLoop({
        projectRoot: input.projectRoot, assertBudget: input.assertBudget, onEvent: input.onEvent,
        async getConfig(signal, context) {
          signal?.throwIfAborted();
          const resolved = await resolveVerifyCommands(input.projectRoot, { signal });
          const saved = loadProjectVerifyConfig(ctx.dataDir, input.projectRoot, resolved.fingerprint);
          if (saved) { activeConfig = { ...saved, mode: input.mode }; return activeConfig; }
          if (!resolved.commands.length) return { unavailable: '项目未提供可运行的检查命令。' };
          if (!selectVerifyCommands(resolved.commands, input.mode, input.projectRoot, context?.changedFiles ?? []).length) return { unavailable: '快速模式没有可运行的检查，请选择完整验证或配置快速检查命令。' };
          const approved = await ctx.host.confirm({ kind: 'verification', projectRoot: input.projectRoot, commands: resolved.commands, configPath: projectVerifyConfigPath(ctx.dataDir, input.projectRoot), signal });
          signal?.throwIfAborted();
          if (!approved) return { unavailable: '用户选择本轮跳过检查。' };
          const current = await resolveVerifyCommands(input.projectRoot, { signal });
          if (current.fingerprint !== resolved.fingerprint) return { unavailable: '确认期间项目检查来源发生变化，请重新确认后运行。' };
          activeConfig = confirmProjectVerifyConfig(ctx.dataDir, input.projectRoot, { ...defaultVerifyConfig(resolved.commands), mode: input.mode }, resolved.fingerprint);
          for (const command of activeConfig.commands) initiallyApproved.add(command.command);
          return activeConfig;
        },
        async execute(command, { signal, timeoutMs }) {
          signal?.throwIfAborted(); input.assertBudget();
          const current = await resolveVerifyCommands(input.projectRoot, { signal });
          if (!activeConfig || current.fingerprint !== activeConfig.manifestFingerprint) throw new Error('检查来源已发生变化，请重新确认项目验证命令');
          if (!initiallyApproved.delete(command.command) && !(await confirmCoreCommand(ctx, command.command, input.projectRoot, signal))) throw new Error('用户未批准项目检查：' + command.label);
          signal?.throwIfAborted(); input.assertBudget();
          const result = await ctx.projectProcesses.run({ projectRoot: input.projectRoot, command: command.command, timeoutMs, signal });
          return { exitCode: result.exitCode, output: result.output, durationMs: result.durationMs, timedOut: result.timedOut, cancelled: result.cancelled };
        },
      });
    },
  };
}
