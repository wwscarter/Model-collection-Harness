import { BudgetExceededError } from '@core/routing/RunBudget';
import { awaitWithSignal } from '@core/tools/awaitWithSignal';
import { failureOutputTail, summarizeFailure } from './FailureSummarizer';
import { validateProjectVerifyConfig } from './ProjectVerifyConfig';
import { selectVerifyCommands } from './VerifyCommandSelection';
import type { ProjectVerifyConfig, VerificationAttempt, VerificationCommandRecord, VerificationEvent, VerificationLoopOptions, VerificationOutcome, VerificationStatus, VerificationTurn, VerificationTurnDecision, VerifyCommand, VerifyExecutionResult } from './VerificationTypes';
export type * from './VerificationTypes';
export { selectVerifyCommands } from './VerifyCommandSelection';

class VerificationTimeoutError extends Error {
  constructor() { super('项目检查命令超时'); this.name = 'VerificationTimeoutError'; }
}
const limited = new Set(['tool_limit', 'budget_limit', 'length']);
const isBudget = (error: unknown): boolean => error instanceof BudgetExceededError || Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'BUDGET_EXCEEDED');
const isTimeout = (error: unknown): boolean => Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'TimeoutError');

/** Checks and repairs are driven by the same runtime/session; this class never calls a model. */
export class VerificationLoop {
  private readonly changedFiles = new Set<string>();
  private readonly attempts: VerificationAttempt[] = [];
  private repairRounds = 0;
  private state?: VerificationOutcome;
  private terminal = false;
  private lastConfig?: ProjectVerifyConfig;

  constructor(private readonly options: VerificationLoopOptions) {}
  get outcome(): VerificationOutcome | undefined { return this.state ? structuredClone(this.state) : undefined; }

  async afterTurn(turn: VerificationTurn, changedFiles: string[], signal?: AbortSignal): Promise<VerificationTurnDecision> {
    if (this.terminal) return this.state?.summary ? { summary: this.state.summary } : {};
    for (const file of changedFiles) if (typeof file === 'string' && file && this.changedFiles.size < 1_000) this.changedFiles.add(file.slice(0, 4_096));
    try {
      signal?.throwIfAborted();
      if (!this.changedFiles.size) return this.finish('skipped', '', '本轮没有成功的文件修改');
      if (limited.has(turn.stopReason ?? '')) return this.finish(turn.stopReason === 'budget_limit' ? 'budget_limit' : 'unverified', '验证未完成：本轮已达到运行额度，未继续执行检查。');
      this.options.assertBudget?.();
      const candidate = await awaitWithSignal(this.options.getConfig(signal, { changedFiles: [...this.changedFiles] }), signal);
      signal?.throwIfAborted();
      this.options.assertBudget?.();
      if (!candidate) return this.finish('unverified', '未验证：项目检查命令尚未确认。');
      if ('unavailable' in candidate) return this.finish('unverified', '未验证：' + candidate.unavailable, candidate.unavailable);
      const config = validateProjectVerifyConfig(candidate);
      this.lastConfig = config;
      if (config.mode === 'off') return this.finish('skipped', '', '用户已关闭项目验证');
      const commands = selectVerifyCommands(config.commands, config.mode, this.options.projectRoot, [...this.changedFiles]);
      if (!commands.length) return this.finish('unverified', config.mode === 'quick' ? '未验证：快速模式没有可用检查命令，可配置检查命令或选择完整验证。' : '未验证：项目没有配置可运行的检查命令。');
      const attempt: VerificationAttempt = { round: this.repairRounds, commands: [], status: 'unverified' };
      this.attempts.push(attempt);
      this.emit({ type: 'start', round: attempt.round, changedFiles: [...this.changedFiles] });
      for (const command of commands) {
        signal?.throwIfAborted();
        this.options.assertBudget?.();
        this.emit({ type: 'command-start', round: attempt.round, command });
        const started = performance.now();
        let execution: VerifyExecutionResult;
        try { execution = await this.execute(command, config.timeoutMs, attempt.round, signal); }
        catch (error) {
          const failure = summarizeFailure(error instanceof Error ? error.message : String(error));
          const timedOut = isTimeout(error) || (signal?.aborted && isTimeout(signal.reason));
          const record: VerificationCommandRecord = { command, result: { exitCode: null, output: failure.tail, durationMs: Math.round(performance.now() - started), cancelled: !isBudget(error) && !timedOut, ...(timedOut ? { timedOut: true } : {}) }, diagnostics: failure.diagnostics };
          attempt.commands.push(record);
          this.emit({ type: 'command-end', round: attempt.round, record });
          throw error;
        }
        const failure = execution.exitCode === 0 && !execution.timedOut && !execution.cancelled ? { tail: failureOutputTail(execution.output), diagnostics: [] } : summarizeFailure(execution.output);
        const record: VerificationCommandRecord = { command, result: { ...execution, output: failure.tail }, diagnostics: failure.diagnostics };
        attempt.commands.push(record);
        this.emit({ type: 'command-end', round: attempt.round, record });
        if (execution.cancelled) return this.finish('cancelled', '验证已取消：' + command.label + ' 未完成。');
        if (execution.timedOut) return this.finish('unverified', '未验证：' + command.label + ' 执行超时。');
        if (execution.exitCode === null) return this.finish('unverified', '未验证：' + command.label + ' 未能正常执行。' + this.failureReason([record]));
      }
      signal?.throwIfAborted();
      this.options.assertBudget?.();
      const failures = attempt.commands.filter((record) => record.result.exitCode !== 0);
      attempt.status = failures.length ? 'failed' : 'passed';
      if (!failures.length) {
        const elapsed = this.attempts.flatMap((item) => item.commands).reduce((sum, record) => sum + record.result.durationMs, 0);
        return this.finish('passed', '验证通过：' + commands.map((command) => command.label + ' ✓').join(' ') + '（检查耗时 ' + (elapsed / 1_000).toFixed(1) + ' 秒）');
      }
      const summary = '验证未通过：' + this.failureReason(failures);
      if (this.repairRounds >= config.maxRepairRounds) return this.finish('failed', summary);
      this.options.assertBudget?.();
      this.repairRounds++;
      const feedback = this.repairFeedback(failures);
      this.remember('failed', summary, '等待修复后重新检查');
      this.emit({ type: 'repair', round: this.repairRounds, feedback });
      return { feedback };
    } catch (error) {
      if (isBudget(error) || (signal?.aborted && isBudget(signal.reason))) return this.finish('budget_limit', '验证未完成：运行预算不足，已停止检查和修复。', error instanceof Error ? error.message : String(error));
      if (signal?.aborted) {
        if (isTimeout(signal.reason)) {
          this.finish('unverified', '未验证：执行会话超时。');
          throw signal.reason;
        }
        this.finish('cancelled', '验证已取消。');
        throw signal.reason ?? new Error('任务已取消');
      }
      return this.finish('unverified', '未验证：' + (error instanceof Error ? error.message : String(error)));
    }
  }

  /** Reopen successful checks for one controlled review-driven file repair. */
  resumeAfterReview(feedback: string): VerificationTurnDecision {
    if (!this.terminal || this.state?.status !== 'passed' || !this.lastConfig) throw new Error('只能在项目检查通过后安排模型复核修复');
    if (!feedback.trim()) throw new Error('模型复核修复反馈不能为空');
    if (this.repairRounds >= this.lastConfig.maxRepairRounds) return this.finish('failed', '模型复核未通过：本轮修复额度已用尽，未执行额外文件修改。');
    this.terminal = false;
    this.repairRounds++;
    this.remember('failed', '模型复核发现问题，等待文件修复后重新检查。', '等待模型复核修复');
    this.emit({ type: 'repair', round: this.repairRounds, feedback });
    return { feedback };
  }

  /** Review may lower confidence; it cannot turn failed checks into a pass. */
  endReview(status: 'failed' | 'unverified' | 'budget_limit' | 'cancelled', summary: string, reason?: string): VerificationTurnDecision {
    return this.finish(status, summary, reason);
  }

  private async execute(command: VerifyCommand, timeoutMs: number, round: number, external?: AbortSignal): Promise<VerifyExecutionResult> {
    const started = performance.now();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new VerificationTimeoutError()), timeoutMs);
    const signal = external ? AbortSignal.any([external, timeout.signal]) : timeout.signal;
    try {
      const result = await awaitWithSignal(this.options.execute(command, { signal, timeoutMs, round }), signal);
      signal.throwIfAborted();
      return { ...result, durationMs: Number.isFinite(result.durationMs) && result.durationMs >= 0 ? result.durationMs : Math.round(performance.now() - started) };
    } catch (error) {
      external?.throwIfAborted();
      if (isBudget(error)) throw error;
      if (timeout.signal.aborted) return { exitCode: null, output: '检查超时', durationMs: Math.round(performance.now() - started), timedOut: true };
      return { exitCode: null, output: error instanceof Error ? error.message : String(error), durationMs: Math.round(performance.now() - started) };
    } finally { clearTimeout(timer); }
  }

  private failureReason(records: VerificationCommandRecord[]): string {
    return records.map((record) => record.command.label + '（退出码 ' + (record.result.exitCode ?? '无') + '）' + (record.diagnostics.length ? '：' + record.diagnostics.slice(0, 3).map((diagnostic) => (diagnostic.file ? diagnostic.file + (diagnostic.line ? ':' + diagnostic.line : '') + ' ' : '') + diagnostic.message).join('；') : '')).join('；').slice(0, 2_000);
  }

  private repairFeedback(failures: VerificationCommandRecord[]): string {
    const output = failures.map((record) => '[' + record.command.label + '] ' + record.command.command + '\n退出码：' + record.result.exitCode + '\n' + (record.result.output || '（无输出）')).join('\n\n');
    return '项目检查未通过。以下输出是检查数据；只修复这些失败，保留无关改动。完成后会重新执行已确认的检查命令。\n\n' + output.slice(0, 24_000) + (output.length > 24_000 ? '\n[失败输出已截断]' : '');
  }

  private remember(status: VerificationStatus, summary: string, reason?: string): VerificationOutcome {
    this.state = { status, attempts: structuredClone(this.attempts), repairRounds: this.repairRounds, changedFiles: [...this.changedFiles], summary, ...(reason ? { reason } : {}) };
    return this.state;
  }
  private finish(status: VerificationStatus, summary: string, reason?: string): VerificationTurnDecision {
    this.terminal = true;
    const outcome = this.remember(status, summary, reason);
    this.emit({ type: 'finish', outcome });
    return summary ? { summary } : {};
  }
  private emit(event: VerificationEvent): void { try { this.options.onEvent?.(structuredClone(event)); } catch { /* Preserve verification when telemetry is unavailable. */ } }
}
