import { BudgetExceededError } from '@core/routing/RunBudget';
import type { TraceSpanHandle } from '@core/trace/TraceRecorder';
import type { VerificationEvent, VerificationOutcome, VerificationTurnDecision } from '@core/verify/VerificationTypes';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentRunRequest, AgentTurnContinuation } from '../AgentRuntime';
import { reviewProjectTurn } from './projectModelReview';
import type { RunContext } from './RunContext';
import { limitedStop } from './runHelpers';
import type { RunDependencies } from './RunTypes';

type Loop = ReturnType<NonNullable<RunDependencies['createProjectVerification']>>;

function changedFiles(ctx: RunContext, offset = 0): string[] {
  return [...new Set(ctx.successfulFileWrites.slice(offset).flatMap((file) => {
    if (!ctx.projectRoot) return [];
    let relative = path.relative(ctx.projectRoot, path.resolve(ctx.projectRoot, file));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      try { relative = path.relative(fs.realpathSync(ctx.projectRoot), fs.realpathSync(path.resolve(ctx.projectRoot, file))); } catch { return []; }
    }
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? [relative.split(path.sep).join('/')] : [];
  }))];
}

/** Own verification telemetry while the runtime keeps the live Pi session. */
export class ProjectVerificationSession {
  private loop?: Loop;
  private span?: TraceSpanHandle;
  private repairSpan?: TraceSpanHandle;
  private repairOffset = 0;
  private commands = new Map<string, TraceSpanHandle>();
  private completed = false;
  private reviewRepairIssued = false;
  private reviewOffset = 0;

  constructor(private ctx: RunContext) { }

  readonly afterTurn: NonNullable<AgentRunRequest['afterTurn']> = async (turn, context) => {
    const mode = this.ctx.request.verificationMode ?? 'quick';
    const factory = this.ctx.deps.createProjectVerification;
    const root = this.ctx.projectRoot;
    if (mode === 'off' || !root || !factory || !this.ctx.enableTools) return undefined;
    const files = changedFiles(this.ctx);
    if (!this.loop && (!files.length || limitedStop(turn.stopReason))) return undefined;
    const signal = context?.signal ?? this.ctx.controller.signal;
    try {
      if (!this.loop) {
        this.span = this.ctx.trace.child('verify', 'project-verify', { mode, changedFiles: files.length });
        this.emit({ phase: 'checking', status: 'running', round: 0 });
        this.loop = factory({ projectRoot: root, mode, runId: this.ctx.runId, assertBudget: () => this.ctx.runBudget.assertAvailable(), onEvent: (event) => this.onEvent(event) });
      }
      if (this.reviewRepairIssued && !limitedStop(turn.stopReason) && !changedFiles(this.ctx, this.reviewOffset).length) {
        return this.decision(this.loop.endReview('failed', '模型复核未通过：修订回合没有成功修改项目文件，复核问题尚未解决。'));
      }
      const decision = await this.loop.afterTurn(turn, files, signal);
      const outcome = this.loop.outcome;
      if (outcome?.status !== 'passed') return this.decision(decision);
      this.emit({ phase: 'checking', status: 'running', summary: '项目检查结束，正在复核当前文件。' });
      const review = await reviewProjectTurn(this.ctx, turn, outcome, signal, this.reviewRepairIssued ? 2 : 1);
      if (review.kind === 'revise') {
        if (this.reviewRepairIssued) return this.decision(this.loop.endReview('failed', (review.summary ?? '模型复核未通过。') + ' 已完成一次文件修订，剩余问题尚未解决。'));
        this.reviewRepairIssued = true;
        this.reviewOffset = this.ctx.successfulFileWrites.length;
        return this.decision(this.loop.resumeAfterReview(review.feedback!));
      }
      if (review.kind === 'unverified' || review.kind === 'budget_limit') return this.decision(this.loop.endReview(review.kind, review.summary ?? '未验证：模型复核未完成。'));
      if (review.kind === 'approved' && this.ctx.verification) this.ctx.verification.revised = this.reviewRepairIssued;
      this.complete(outcome);
      return this.decision(decision);
    } catch (error) {
      this.finish(error);
      if (signal.aborted) throw error;
      return { summary: this.ctx.projectVerification?.summary };
    }
  };

  private decision(decision: VerificationTurnDecision): AgentTurnContinuation {
    if (this.loop?.outcome?.status !== 'budget_limit') return decision;
    this.ctx.noteBudgetLimit(this.loop.outcome.reason ?? this.loop.outcome.summary);
    return { ...decision, stopReason: 'budget_limit' };
  }

  private emit(value: Record<string, unknown>): void {
    this.ctx.emit('session:verification', { sessionId: this.ctx.sessionId, taskId: this.ctx.taskId, runId: this.ctx.runId, assistantMessageId: this.ctx.assistantMessageId, ...value });
  }

  private onEvent(event: VerificationEvent): void {
    if (this.completed) return;
    if (event.type === 'start') {
      this.repairSpan?.end({ attributes: { modifiedFiles: changedFiles(this.ctx, this.repairOffset).length } });
      this.repairSpan = undefined;
      this.emit({ phase: 'checking', status: 'running', round: event.round });
    } else if (event.type === 'command-start') {
      const key = event.round + ':' + event.command.id;
      const span = this.span?.child('verify-command', event.command.label, { round: event.round, command: event.command.command, phase: event.command.phase });
      if (span) this.commands.set(key, span);
    } else if (event.type === 'command-end') {
      const { command, result } = event.record;
      const key = event.round + ':' + command.id;
      const success = result.exitCode === 0 && !result.timedOut && !result.cancelled;
      this.commands.get(key)?.end({ status: success ? 'success' : result.cancelled ? 'cancelled' : 'failed', error: success ? undefined : event.record.diagnostics[0]?.message ?? (result.timedOut ? '检查超时' : '检查未通过'), attributes: { exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut, cancelled: result.cancelled, output: result.output.slice(-3_000) } });
      this.commands.delete(key);
    } else if (event.type === 'repair') {
      this.repairOffset = this.ctx.successfulFileWrites.length;
      this.repairSpan = this.span?.child('verify-repair', 'verification-repair', { round: event.round });
      this.emit({ phase: 'repair', status: 'running', round: event.round, summary: '正在根据验证反馈修复，完成后重新检查。' });
    } else if (event.outcome.status !== 'passed') this.complete(event.outcome);
  }

  private complete(outcome: VerificationOutcome): void {
    if (this.completed) return;
    this.completed = true;
    this.ctx.projectVerification = outcome;
    const status = outcome.status === 'passed' || outcome.status === 'skipped' ? 'success' : outcome.status === 'cancelled' ? 'cancelled' : 'failed';
    for (const command of this.commands.values()) command.end({ status, error: outcome.reason ?? outcome.summary });
    this.commands.clear();
    this.repairSpan?.end({ status, error: status === 'success' ? undefined : outcome.reason ?? outcome.summary, attributes: { modifiedFiles: changedFiles(this.ctx, this.repairOffset).length } });
    this.span?.end({ status, error: status === 'success' ? undefined : outcome.reason ?? outcome.summary, attributes: { status: outcome.status, attempts: outcome.attempts.length, repairRounds: outcome.repairRounds, changedFiles: outcome.changedFiles.length } });
    try {
      this.ctx.deps.observability.recordVerification({ runId: this.ctx.runId, status: outcome.status, attempts: outcome.attempts.length, repairRounds: outcome.repairRounds, durationMs: outcome.attempts.flatMap((attempt) => attempt.commands).reduce((sum, record) => sum + record.result.durationMs, 0) });
    } catch (error) { console.warn('项目验证指标保存失败', error); }
    this.emit({ phase: 'completed', status: outcome.status, summary: outcome.summary, attempts: outcome.attempts.length, repairRounds: outcome.repairRounds });
  }

  finish(error?: unknown): void {
    if (!this.span || this.completed) return;
    const known = this.loop?.outcome;
    const aborted = this.ctx.controller.signal.aborted || (error instanceof Error && error.message === '任务已取消');
    const budget = error instanceof BudgetExceededError || this.ctx.controller.signal.reason instanceof BudgetExceededError;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.message.includes('任务执行超时'));
    const status = budget ? 'budget_limit' : aborted && !timedOut ? 'cancelled' : 'unverified';
    const summary = budget ? '验证未完成：运行预算不足，已停止检查和修复。' : timedOut ? '未验证：执行会话超时，未完成检查或模型复核。' : aborted ? '验证已取消。' : '未验证：执行会话未完成检查或修复。';
    if (this.loop && known) { this.loop.endReview(status, summary, error instanceof Error ? error.message : error === undefined ? undefined : String(error)); return; }
    this.complete({ status, attempts: known?.attempts ?? [], repairRounds: known?.repairRounds ?? 0, changedFiles: known?.changedFiles ?? changedFiles(this.ctx), summary, ...(error ? { reason: error instanceof Error ? error.message : String(error) } : {}) });
  }
}
