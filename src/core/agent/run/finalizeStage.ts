import { auditCodeAnswer } from '@core/audit/AuditService';
import { extractMemories } from '@core/memory/MemoryExtractor';
import { snapshotModel } from '@core/models/ModelSnapshot';
import { selectUtilityModel } from '@core/routing/ModelCollaboration';
import { BudgetExceededError } from '@core/routing/RunBudget';
import type { RunContext } from './RunContext';
import { costOf, limitedStop, limitMessage, PARTIAL_AGENT_NOTICE, publicModel } from './runHelpers';

/** Audit the answer, store memories and publish completion. */
export async function finalizeStage(ctx: RunContext): Promise<Record<string, unknown>> {
  // Static code audit is deterministic and free. It runs only when the
  // answer actually contains code, and its result feeds the same audit log,
  // metrics table and growth profile instead of leaving them empty.
  const auditSpan = ctx.trace.child('audit', 'static-audit', { modelId: ctx.executionModel.id, modelSnapshot: snapshotModel(ctx.executionModel) });
  const audit = auditCodeAnswer(ctx.result.content, ctx.runId, ctx.executionModel.id, { auditor: ctx.deps.codeAuditor, log: ctx.deps.auditLog, metrics: ctx.deps.observability });
  auditSpan.end({ attributes: audit ? { passed: audit.passed, score: audit.score, issues: audit.issueCount, auditModelId: audit.auditModelId } : { skipped: 'no-code' } });
  const extractedMemoryIds: string[] = [];
  let autoExtract = false;
  try {
    autoExtract = ctx.deps.memory.getAutoExtract();
  }
  catch { /* memory settings must not fail an answer */ }
  if (!['tool_limit', 'budget_limit', 'length'].includes(ctx.result.stopReason ?? '') && autoExtract && !ctx.controller.signal.aborted) {
    const extractionModel = selectUtilityModel(ctx.deps.models.getEnabledModels().filter((candidate) => ctx.deps.quota.isAvailable(candidate)), ctx.executionModel.id, ctx.deps.routingSettings?.utilityModelId);
    if (extractionModel) {
      const extractionSpan = ctx.trace.child('memory', 'memory.extract', { modelId: extractionModel.id, modelSnapshot: snapshotModel(extractionModel), role: 'extractor' });
      try {
        ctx.runBudget.assertAvailable();
        const extractionInvocationId = ctx.deps.observability.recordInvocationStart(ctx.runId, extractionModel.id);
        try {
          const extraction = await extractMemories({
            prompt: ctx.request.prompt,
            answer: ctx.result.content,
            model: extractionModel,
            provider: ctx.createProvider(extractionModel),
            signal: AbortSignal.any([ctx.controller.signal, AbortSignal.timeout(20000)]),
          });
          const extractionCost = costOf(extraction.inputTokens, extraction.outputTokens, extractionModel);
          ctx.deps.observability.recordInvocationEnd(extractionInvocationId, extraction.inputTokens, extraction.outputTokens, extractionModel.costPer1kTokens, 'success');
          for (const memory of extraction.memories) {
            try {
              const scope = ctx.projectRoot ? 'project' : 'global';
              const saved = ctx.deps.memory.add({
                content: memory.content, kind: memory.kind, tags: memory.tags, source: 'agent', status: 'pending',
                scope, projectRoot: scope === 'project' ? ctx.projectRoot : undefined,
              });
              extractedMemoryIds.push(saved.id);
            }
            catch { /* rejected content must not fail the answer */ }
          }
          extractionSpan.end({ inputTokens: extraction.inputTokens, outputTokens: extraction.outputTokens, cost: extractionCost, attributes: { extracted: extractedMemoryIds.length, modelId: extractionModel.id } });
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.deps.observability.recordInvocationEnd(extractionInvocationId, 0, 0, extractionModel.costPer1kTokens, 'failure', message);
          extractionSpan.end({ status: 'failed', error: message });
        }
      }
      catch (error) {
        extractionSpan.end({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
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
  if (ctx.metrics && !['tool_limit', 'budget_limit', 'length'].includes(ctx.result.stopReason ?? '')) {
    ctx.recordGrowth({ modelId: ctx.executionModel.id, taskType: ctx.decision.taskType, success: true, completed: true, actualCost: ctx.metrics.totalCost, estimatedCost: ctx.decision.estimatedCost, actualLatency: ctx.metrics.latency, estimatedLatency: ctx.decision.estimatedDuration, auditApproval: audit?.passed });
  }
  if (ctx.executionModel.id !== ctx.model.id) {
    ctx.emit('session:model-switched', { sessionId: ctx.sessionId, taskId: ctx.taskId, runId: ctx.runId, ...ctx.decision, modelId: ctx.executionModel.id, role: 'execution', planningModelId: ctx.planningModelId, fallback: true });
  }
  const stopReason = ctx.result.stopReason;
  if (ctx.budgetLimit)
    ctx.budgetLimit.estimatedCost = ctx.totalCost;
  const reportedAgents = ctx.agentReports.map((report) => report.stopReason === 'tool_limit' ? { ...report, content: `${PARTIAL_AGENT_NOTICE}\n\n${report.content}` } : report);
  const runMetrics = { ...ctx.metrics, startTime: new Date(ctx.startedAt), endTime: new Date(), inputTokens: ctx.totalInputTokens, outputTokens: ctx.totalOutputTokens, totalCost: ctx.totalCost, latency: Date.now() - ctx.startedAt, stopReason, ...(ctx.budgetLimit ? { budgetLimit: ctx.budgetLimit } : {}) };
  const output = { sessionId: ctx.sessionId, taskId: ctx.taskId, runId: ctx.runId, assistantMessageId: ctx.assistantMessageId, output: ctx.result.content, stopReason, modelUsed: publicModel(ctx.executionModel), modelsUsed: ctx.deps.observability.getTaskMetrics(ctx.runId).modelsUsed, fallbackAttempts: ctx.fallbackAttempts, planningModelId: ctx.planningModelId, pinnedModelId: ctx.pinned?.id, decision: ctx.decision, orchestration: ctx.orchestration ? { orchestratorModelId: ctx.planningModelId, planningModelId: ctx.planningModelId, executorModelId: ctx.executionModel.id, synthesizerModelId: ctx.executionModel.id, mode: ctx.orchestration.mode, taskType: ctx.orchestration.taskType, complexity: ctx.orchestration.complexity, reason: ctx.orchestration.reason, plan: ctx.orchestration.plan, subagents: ctx.orchestration.subagents, verify: ctx.orchestration.verify } : undefined, metrics: runMetrics, verification: ctx.verification, audit, extractedMemoryIds, agentReports: reportedAgents, agentMessages: ctx.agentMessages, toolCalls: ctx.toolCalls.map(({ details: _details, ...call }) => call), project: ctx.projectContext ? { root: ctx.projectContext.root, files: ctx.projectContext.files.map((file) => file.path), tokenCount: ctx.projectContext.tokenCount, truncated: ctx.projectContext.truncated, skippedFiles: ctx.projectContext.skippedFiles } : undefined };
  Object.assign(output, ctx.budgetLimit ? { budgetLimit: ctx.budgetLimit } : {});
  ctx.finishTrace(limitedStop(stopReason) ? 'failed' : 'success', ctx.budgetLimit?.message ?? limitMessage(stopReason));
  ctx.emit('session:completed', output);
  return output;
}
