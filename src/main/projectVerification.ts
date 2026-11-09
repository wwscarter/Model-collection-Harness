import { dialog } from 'electron';
import { VerificationLoop } from '@core/verify/VerificationLoop';
import { resolveVerifyCommands } from '@core/verify/VerifyCommandResolver';
import { selectVerifyCommands } from '@core/verify/VerifyCommandSelection';
import { confirmProjectVerifyConfig, defaultVerifyConfig, loadProjectVerifyConfig, projectVerifyConfigPath } from '@core/verify/ProjectVerifyConfig';
import type { RunDependencies } from '@core/agent/RunCoordinator';
import type { ProjectVerifyConfig } from '@core/verify/VerificationTypes';
import type { MainContext } from './MainContext';
import { confirmCommand } from './approvalPrompt';

type VerificationInput = Parameters<NonNullable<RunDependencies['createProjectVerification']>>[0];

/** The native host confirms scripts; the core loop owns checks and repair limits. */
export function createProjectVerification(ctx: MainContext, input: VerificationInput): VerificationLoop {
  const initiallyApproved = new Set<string>();
  let activeConfig: ProjectVerifyConfig | undefined;
  return new VerificationLoop({
    projectRoot: input.projectRoot,
    assertBudget: input.assertBudget,
    onEvent: input.onEvent,
    async getConfig(signal, context) {
      signal?.throwIfAborted();
      const resolved = await resolveVerifyCommands(input.projectRoot, { signal });
      const saved = loadProjectVerifyConfig(ctx.dataDir, input.projectRoot, resolved.fingerprint);
      if (saved) { activeConfig = { ...saved, mode: input.mode }; return activeConfig; }
      if (!resolved.commands.length) return { unavailable: '未验证：项目未提供可运行的检查命令。' };
      if (!selectVerifyCommands(resolved.commands, input.mode, input.projectRoot, context?.changedFiles ?? []).length) return { unavailable: '未验证：快速模式没有可运行的检查，请选择完整验证或配置快速检查命令。' };
      const options = {
        type: 'question' as const, title: '确认项目验证命令', signal,
        message: '允许在修改项目文件后运行以下检查？',
        detail: '项目：' + input.projectRoot + '\n\n' + resolved.commands.map((command) => (command.phase === 'quick' ? '快速' : '完整') + ' · ' + command.label + '\n' + command.command).join('\n\n')
          + '\n\n修改测试文件时也会运行测试。确认的命令保存在：\n' + projectVerifyConfigPath(ctx.dataDir, input.projectRoot),
        buttons: ['本轮跳过', '确认并运行'], defaultId: 0, cancelId: 0, noLink: true,
      };
      const window = ctx.getWindow();
      const answer = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      signal?.throwIfAborted();
      if (answer.response !== 1) return { unavailable: '未验证：用户选择本轮跳过检查。' };
      const current = await resolveVerifyCommands(input.projectRoot, { signal });
      if (current.fingerprint !== resolved.fingerprint) return { unavailable: '未验证：确认期间项目检查来源发生变化，请重新确认后运行。' };
      const config = confirmProjectVerifyConfig(ctx.dataDir, input.projectRoot, { ...defaultVerifyConfig(resolved.commands), mode: input.mode }, resolved.fingerprint);
      activeConfig = config;
      for (const command of config.commands) initiallyApproved.add(command.command);
      return config;
    },
    async execute(command, { signal, timeoutMs }) {
      signal?.throwIfAborted(); input.assertBudget();
      const current = await resolveVerifyCommands(input.projectRoot, { signal });
      if (!activeConfig || current.fingerprint !== activeConfig.manifestFingerprint) throw new Error('检查来源已发生变化，请重新确认项目验证命令');
      if (!initiallyApproved.delete(command.command) && !(await confirmCommand(ctx, command.command, input.projectRoot, signal, input.projectRoot))) throw new Error('用户未批准项目检查：' + command.label);
      signal?.throwIfAborted(); input.assertBudget();
      const result = await ctx.projectProcesses.run({ projectRoot: input.projectRoot, command: command.command, timeoutMs, signal });
      return { exitCode: result.exitCode, output: result.output, durationMs: result.durationMs, timedOut: result.timedOut, cancelled: result.cancelled };
    },
  });
}
