import type { RunPlan } from '@core/planning/PlanTypes';
import { parsePlanSteps, planningMode } from '@core/planning/PlanTypes';
import type { RunContext } from './RunContext';
import { publicModel } from './runHelpers';

/** Publish a durable plan before any execution, then apply the requested confirmation mode. */
export async function presentPlan(ctx: RunContext): Promise<void> {
  const mode = planningMode(ctx.request.planningMode ?? ctx.deps.routingSettings?.planning.executionMode ?? 'auto');
  if (!ctx.orchestration) {
    if (mode !== 'auto') throw new Error('未能生成有效计划，请检查规划模型配置后重试');
    return;
  }
  if (!ctx.orchestration.steps.length) ctx.orchestration.steps = parsePlanSteps(undefined, ctx.orchestration.reason || ctx.request.prompt);
  const publish = (plan: RunPlan) => { ctx.runPlan = plan; ctx.emit('session:plan', plan); };
  const initial = ctx.plans.create({ sessionId: ctx.sessionId, runId: ctx.runId, assistantMessageId: ctx.assistantMessageId, executionMode: mode, status: mode === 'confirm' ? 'awaiting' : 'ready', plan: ctx.orchestration });
  ctx.runPlan = initial;
  if (mode === 'confirm') {
    const span = ctx.trace.child('plan', 'plan.confirmation', { version: initial.version });
    const resume = ctx.pauseDeadline();
    try {
      const approved = await ctx.plans.wait(initial, ctx.controller.signal, publish);
      ctx.orchestration = approved.plan;
      span.end({ attributes: { version: approved.version, approved: true } });
    } catch (error) {
      span.end({ status: 'cancelled', error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { resume(); }
  } else publish(initial);
  if (mode === 'only') {
    const plan = ctx.plans.status(ctx.runId, 'completed', publish)!;
    const content = ['执行计划', ...plan.plan.steps.map((step, index) => (index + 1) + '. ' + step.title + (step.detail ? '：' + step.detail : ''))].join(String.fromCharCode(10) + String.fromCharCode(10));
    ctx.planOnlyOutput = { sessionId: ctx.sessionId, taskId: ctx.taskId, runId: ctx.runId, assistantMessageId: ctx.assistantMessageId, output: content, stopReason: 'plan_only', planningModelId: ctx.planningModelId, modelUsed: publicModel(ctx.model), plan, decision: ctx.decision, metrics: { inputTokens: ctx.totalInputTokens, outputTokens: ctx.totalOutputTokens, totalCost: ctx.totalCost, latency: ctx.runBudget.snapshot().elapsedMs, stopReason: 'plan_only' }, toolCalls: [] };
    return;
  }
  ctx.plans.status(ctx.runId, 'executing', publish);
}
