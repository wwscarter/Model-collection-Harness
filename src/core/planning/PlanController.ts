import type { PlanStorage } from './PlanStorage';
import { parsePlanSteps, type PlanDecision, type PlanStatus, type RunPlan, type PlanStepStatus } from './PlanTypes';

type PlanRepository = Pick<PlanStorage, 'save' | 'latest' | 'list' | 'deleteSession'>;
interface Pending { record: RunPlan; resolve(plan: RunPlan): void; reject(error: Error): void; publish(plan: RunPlan): void; }

/** Owns only plan state and decisions; the run owns cancellation and budget timing. */
export class PlanController {
  private readonly pending = new Map<string, Pending>();
  private readonly current = new Map<string, RunPlan>();
  constructor(private readonly storage?: PlanRepository) {}
  private save(record: RunPlan): RunPlan {
    const next = structuredClone(record);
    const previous = this.current.get(record.runId) ?? this.storage?.latest(record.runId);
    if (previous && next.updatedAt <= previous.updatedAt) next.updatedAt = new Date(Date.parse(previous.updatedAt) + 1).toISOString();
    this.storage?.save(next); this.current.set(next.runId, next);
    return structuredClone(next);
  }
  create(input: Omit<RunPlan, 'version' | 'createdAt' | 'updatedAt'>): RunPlan {
    const now = new Date().toISOString();
    return this.save({ ...input, version: (this.storage?.latest(input.runId)?.version ?? this.current.get(input.runId)?.version ?? 0) + 1, createdAt: now, updatedAt: now });
  }
  list(sessionId: string): RunPlan[] { return this.storage?.list(sessionId) ?? [...this.current.values()].filter((plan) => plan.sessionId === sessionId).map((plan) => structuredClone(plan)); }
  latest(runId: string): RunPlan | undefined { const plan = this.current.get(runId) ?? this.storage?.latest(runId); return plan ? structuredClone(plan) : undefined; }
  async wait(record: RunPlan, signal: AbortSignal, publish: (plan: RunPlan) => void, timeoutMs = 30 * 60_000): Promise<RunPlan> {
    signal.throwIfAborted();
    return new Promise<RunPlan>((resolve, reject) => {
      const finish = (plan?: RunPlan, error?: Error) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); this.pending.delete(record.runId);
        error ? reject(error) : resolve(plan!);
      };
      const stop = () => {
        const latest = this.pending.get(record.runId)?.record ?? record;
        const cancelled = this.save({ ...latest, status: 'cancelled', updatedAt: new Date().toISOString() });
        publish(cancelled); finish(undefined, new Error('任务已取消'));
      };
      const abort = () => stop();
      const timer = setTimeout(stop, timeoutMs);
      timer.unref?.();
      this.pending.set(record.runId, { record, publish, resolve: (plan) => finish(plan), reject: (error) => finish(undefined, error) });
      signal.addEventListener('abort', abort, { once: true });
      publish(record);
      if (signal.aborted) stop();
    });
  }
  decide(input: PlanDecision): RunPlan {
    if (!input || typeof input.runId !== 'string' || !Number.isInteger(input.version)) throw new Error('计划确认参数无效');
    const pending = this.pending.get(input.runId);
    if (!pending) throw new Error('这份计划已不在等待确认');
    if (pending.record.version !== input.version) throw new Error('计划版本已更新，请使用最新版本');
    const now = new Date().toISOString();
    let next: RunPlan;
    if (input.action === 'edit') {
      const steps = parsePlanSteps(input.steps);
      if (!steps.length) throw new Error('计划至少需要一个有效步骤');
      next = this.save({ ...pending.record, version: pending.record.version + 1, plan: { ...pending.record.plan, steps, plan: steps.map((step, index) => (index + 1) + '. ' + step.title + (step.detail ? '：' + step.detail : '')).join(String.fromCharCode(10)) }, updatedAt: now });
      pending.record = next;
    } else if (input.action === 'approve') {
      next = this.save({ ...pending.record, status: 'approved', approvedAt: now, updatedAt: now });
      pending.resolve(next);
    } else if (input.action === 'cancel') {
      next = this.save({ ...pending.record, status: 'cancelled', updatedAt: now });
      pending.reject(new Error('任务已取消'));
    } else throw new Error('计划操作无效');
    pending.publish(next);
    return next;
  }
  status(runId: string, status: PlanStatus, publish: (plan: RunPlan) => void): RunPlan | undefined {
    const current = this.latest(runId); if (!current) return;
    const next = this.save({ ...current, status, updatedAt: new Date().toISOString() }); publish(next); return next;
  }
  updateStep(runId: string, stepId: string, status: PlanStepStatus, publish: (plan: RunPlan) => void): RunPlan {
    const current = this.latest(runId);
    if (!current || current.status !== 'executing') throw new Error('当前没有正在执行的计划');
    if (!['pending', 'running', 'done', 'skipped'].includes(status)) throw new Error('计划步骤状态无效');
    if (!current.plan.steps.some((step) => step.id === stepId)) throw new Error('计划步骤不存在');
    const next = this.save({ ...current, plan: { ...current.plan, steps: current.plan.steps.map((step) => step.id === stepId ? { ...step, status } : step) }, updatedAt: new Date().toISOString() });
    publish(next); return next;
  }
  deleteSession(sessionId: string): void {
    for (const pending of [...this.pending.values()]) if (pending.record.sessionId === sessionId) this.decide({ runId: pending.record.runId, version: pending.record.version, action: 'cancel' });
    this.storage?.deleteSession(sessionId);
    for (const [runId, plan] of this.current) if (plan.sessionId === sessionId) this.current.delete(runId);
  }
}
