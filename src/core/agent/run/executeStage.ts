import { assembleContext } from '@core/context/ContextAssembler';
import { fitPromptParts, modelContextBudget } from '@core/context/ContextBudget';
import { snapshotModel } from '@core/models/ModelSnapshot';
import { shouldFallback } from '@core/routing/Fallback';
import { buildSynthesisPrompt } from '@core/routing/ModelCollaboration';
import { buildOrchestratedFinalPrompt } from '@core/routing/Orchestrator';
import { BudgetExceededError } from '@core/routing/RunBudget';
import { ProjectVerificationSession } from './projectVerification';
import type { RunContext } from './RunContext';
import { costOf, errorUsage, estimateTokens, limitedStop, limitMessage, PARTIAL_AGENT_NOTICE } from './runHelpers';

/** Stream the answer with usage accounting and fallback. */
export async function executeStage(ctx: RunContext): Promise<void> {
  const buildFinalPrompt = (parts: string[]) => {
    const task = ctx.buildTaskPrompt(parts);
    const reports = ctx.agentReports.map((report, index) => ({ ...report, content: report.stopReason === 'tool_limit' ? `${PARTIAL_AGENT_NOTICE}\n\n${parts[index + 4]}` : parts[index + 4] }));
    return ctx.orchestration ? buildOrchestratedFinalPrompt(task, { ...ctx.orchestration, plan: parts[2], reason: parts[3] }, reports, ctx.failedAgentCount)
      : ctx.collaboratorModels.length ? buildSynthesisPrompt(task, reports, ctx.failedAgentCount) : task;
  };
  const finalParts = [...ctx.taskParts, ctx.orchestration?.plan ?? '', ctx.orchestration?.reason ?? '', ...ctx.agentReports.map((report) => report.content)];
  const protectedPrompt = buildFinalPrompt(finalParts.map(() => ''));
  ctx.executionCandidates = ctx.executionCandidates.filter((candidate) => estimateTokens(protectedPrompt) <= modelContextBudget([candidate]).maxInputTokens);
  if (!ctx.executionCandidates.length)
    throw new Error('任务与执行指令超过模型输入预算，请缩短任务或选择更大上下文的模型');
  ctx.executionContextBudget = modelContextBudget(ctx.executionCandidates);
  const finalPrompt = fitPromptParts(buildFinalPrompt, finalParts, ctx.promptAllowance(protectedPrompt, ctx.executionContextBudget.maxInputTokens));
  ctx.finalContext = assembleContext({ history: ctx.history, summary: ctx.contextAssembly.summary, summaryCovers: ctx.contextAssembly.summaryCovers, summaryHash: ctx.contextAssembly.summaryHash, ...ctx.executionContextBudget, maxInputTokens: ctx.executionContextBudget.maxInputTokens - estimateTokens(finalPrompt) });
  if (ctx.finalContext.summary && ctx.finalContext.summaryChanged)
    ctx.deps.summaries.saveSummary(ctx.sessionId, { text: ctx.finalContext.summary, coversTo: ctx.finalContext.summaryCovers, hash: ctx.finalContext.summaryHash, tokens: estimateTokens(ctx.finalContext.summary) });
  let chunkIndex = 0;
  const projectVerification = new ProjectVerificationSession(ctx);
  for (let index = 0; index < ctx.executionCandidates.length; index += 1) {
    const candidate = ctx.executionCandidates[index];
    ctx.runBudget.assertAvailable();
    if (!ctx.deps.quota.isAvailable(candidate)) {
      if (index < ctx.executionCandidates.length - 1)
        continue;
      throw new Error(`模型「${candidate.name}」已达到速率或每日配额，请稍后再试`);
    }
    ctx.deps.quota.reserve(candidate);
    ctx.executionSpan.setAttributes({ modelId: candidate.id, modelSnapshot: snapshotModel(candidate), attemptIndex: index });
    const attemptInvocationId = ctx.deps.observability.recordInvocationStart(ctx.runId, candidate.id);
    let emittedText = false;
    let emittedTool = false;
    try {
      ctx.executionModel = candidate;
      const attemptResult = await ctx.invokeStreamed(candidate, finalPrompt, ctx.executionContextBudget.maxOutputTokens, (delta) => {
        emittedText = true;
        chunkIndex += 1;
        ctx.emit('session:chunk', { sessionId: ctx.sessionId, taskId: ctx.taskId, delta, index: chunkIndex, modelId: candidate.id });
      }, {
        history: ctx.finalContext.history, summary: ctx.finalContext.summary, skipHistoryTrim: true, enableTools: ctx.enableTools, projectRoot: ctx.projectRoot, signal: ctx.controller.signal, onToolEvent: (event) => {
          if (event.status === 'running')
            emittedTool = true; ctx.emitToolEvent(undefined, event);
        }, afterTurn: projectVerification.afterTurn,
      });
      projectVerification.finish();
      ctx.metrics = ctx.deps.observability.recordInvocationEnd(attemptInvocationId, attemptResult.inputTokens, attemptResult.outputTokens, candidate.costPer1kTokens, attemptResult.stopReason === 'budget_limit' ? 'failure' : 'success', attemptResult.budgetLimitReason);
      ctx.result = attemptResult;
      if (attemptResult.stopReason === 'budget_limit')
        ctx.noteBudgetLimit(attemptResult.budgetLimitReason ?? limitMessage('budget_limit')!);
      try {
        ctx.runBudget.assertAvailable();
      }
      catch (error) {
        if (!(error instanceof BudgetExceededError))
          throw error;
        ctx.noteBudgetLimit(error.message);
        ctx.result = { ...attemptResult, stopReason: 'budget_limit' };
      }
      ctx.executionModel = candidate;
      const executionCost = costOf(attemptResult.inputTokens, attemptResult.outputTokens, candidate);
      ctx.traceAttempts.push({ index, status: limitedStop(ctx.result.stopReason) ? 'failed' : 'success', modelSnapshot: snapshotModel(candidate), inputTokens: attemptResult.inputTokens, outputTokens: attemptResult.outputTokens, estimatedCost: executionCost, ...(limitedStop(ctx.result.stopReason) ? { error: ctx.budgetLimit?.message ?? limitMessage(ctx.result.stopReason) } : {}) });
      ctx.executionSpan.setAttributes({ fallbackAttempts: ctx.fallbackAttempts, attempts: [...ctx.traceAttempts] });
      ctx.executionSpan.end({ status: limitedStop(ctx.result.stopReason) ? 'failed' : 'success', error: limitMessage(ctx.result.stopReason), inputTokens: attemptResult.inputTokens, outputTokens: attemptResult.outputTokens, cost: executionCost, attributes: { stopReason: ctx.result.stopReason } });
      break;
    }
    catch (error) {
      projectVerification.finish(error);
      const message = error instanceof Error ? error.message : String(error);
      const usage = errorUsage(error);
      ctx.traceAttempts.push({ index, status: 'failed', modelSnapshot: snapshotModel(candidate), error: message.slice(0, 500), ...usage, estimatedCost: costOf(usage.inputTokens, usage.outputTokens, candidate) });
      ctx.executionSpan.setAttributes({ attempts: [...ctx.traceAttempts] });
      ctx.metrics = ctx.deps.observability.recordInvocationEnd(attemptInvocationId, usage.inputTokens, usage.outputTokens, candidate.costPer1kTokens, 'failure', message);
      ctx.executionModel = candidate;
      const canFallback = shouldFallback({ index, total: ctx.executionCandidates.length, emittedText, emittedTool, error });
      if (!canFallback) {
        ctx.executionSpan.end({ status: ctx.deps.controller.signal.aborted ? 'cancelled' : 'failed', error: message, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost: costOf(usage.inputTokens, usage.outputTokens, candidate) });
        throw error;
      }
      ctx.fallbackAttempts.push(candidate.id);
      ctx.executionSpan.setAttributes({ fallbackAttempts: ctx.fallbackAttempts });
    }
  }
  if (!ctx.result)
    throw new Error('模型没有返回结果');
  if (ctx.result.stopReason === 'budget_limit' && !ctx.budgetLimit)
    ctx.noteBudgetLimit(ctx.result.budgetLimitReason ?? limitMessage('budget_limit')!);
  try {
    ctx.runBudget.assertAvailable();
  }
  catch (error) {
    if (!(error instanceof BudgetExceededError))
      throw error;
    ctx.noteBudgetLimit(error.message);
    ctx.result = { ...ctx.result, stopReason: 'budget_limit' };
  }
  if (ctx.deps.controller.signal.aborted)
    throw ctx.cancellationError();
  if (ctx.deadline.signal.aborted) {
    ctx.noteBudgetLimit(ctx.cancellationError().message);
    ctx.result = { ...ctx.result, stopReason: 'budget_limit' };
  }
  ctx.synthesisSpan?.end({ status: limitedStop(ctx.result.stopReason) ? 'failed' : 'success', error: limitMessage(ctx.result.stopReason), attributes: { reports: ctx.agentReports.length, failedAgents: ctx.failedAgentCount, partialAgents: ctx.agentReports.filter((report) => limitedStop(report.stopReason)).length, stopReason: ctx.result.stopReason } });
}
