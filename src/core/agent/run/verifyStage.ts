import { assembleContext } from '@core/context/ContextAssembler';
import { fitPromptParts, modelContextBudget } from '@core/context/ContextBudget';
import { snapshotModel } from '@core/models/ModelSnapshot';
import { selectUtilityModel } from '@core/routing/ModelCollaboration';
import { BudgetExceededError } from '@core/routing/RunBudget';
import { chooseRevisionModel } from '../RunOrchestrator';
import { buildRevisionPrompt, hasCode, shouldRevise, verifyCodeAnswer } from '../VerificationService';
import type { RunContext } from './RunContext';
import { costOf, errorUsage, estimateTokens, limitedStop, limitMessage } from './runHelpers';
import { resolveMediaCompletion } from './mediaCompletion';

/** Optionally verify and revise a code answer. */
export async function verifyStage(ctx: RunContext): Promise<void> {
  if (resolveMediaCompletion(ctx.deps.media?.listJobs(ctx.runId, ctx.sessionId) ?? [], ctx.mediaFailures, { runId: ctx.runId, sessionId: ctx.sessionId }).blocked) return;
  // Project changes were reviewed while the live execution session could still
  // edit files and rerun checks. Only legacy answer-only runs use this stage.
  if (ctx.projectVerification) return;
  if (!limitedStop(ctx.result.stopReason) && (ctx.decision.strategy === 'plan+verify' || ctx.decision.strategy === 'escalate') && hasCode(ctx.result.content)) {
    const verifierModel = selectUtilityModel(ctx.deps.models.getEnabledModels().filter((candidate) => candidate.id !== ctx.executionModel.id && ctx.deps.quota.isAvailable(candidate)), ctx.executionModel.id, ctx.deps.routingSettings?.utilityModelId);
    if (verifierModel) {
      const verificationSpan = ctx.trace.child('audit', 'model-verify', { modelId: verifierModel.id, modelSnapshot: snapshotModel(verifierModel) });
      try {
        ctx.runBudget.assertAvailable();
        const verificationInvocationId = ctx.deps.observability.recordInvocationStart(ctx.runId, verifierModel.id);
        try {
          const verified = await verifyCodeAnswer({
            content: ctx.result.content, taskId: ctx.runId, executionModelId: ctx.executionModel.id, model: verifierModel, provider: ctx.createProvider(verifierModel), signal: ctx.controller.signal,
          });
          if (verified) {
            ctx.deps.observability.recordInvocationEnd(verificationInvocationId, verified.inputTokens, verified.outputTokens, verifierModel.costPer1kTokens, 'success');
            ctx.verification = {
              modelId: verifierModel.id,
              approved: verified.audit.approval,
              score: verified.audit.overallScore,
              issueCount: verified.audit.issues.length,
              revised: false,
              auditModelId: verified.audit.auditModelId,
            };
            if (shouldRevise(verified.audit)) {
              const revisionModel = chooseRevisionModel(ctx.executionPlan, ctx.executionModel);
              const revisionSpan = verificationSpan.child('model', 'revision', { modelId: revisionModel.id, modelSnapshot: snapshotModel(revisionModel), role: ctx.decision.strategy === 'escalate' ? 'escalated-reviser' : 'reviser' });
              try {
                ctx.runBudget.assertAvailable();
                ctx.deps.quota.reserve(revisionModel);
                const revisionInvocationId = ctx.deps.observability.recordInvocationStart(ctx.runId, revisionModel.id);
                try {
                  const revisionBudget = modelContextBudget([revisionModel]);
                  const revisionPrompt = fitPromptParts((parts) => buildRevisionPrompt(ctx.request.prompt, parts[0], verified.audit), [ctx.result.content], revisionBudget.maxInputTokens);
                  const revisionContext = assembleContext({ history: ctx.history, summary: ctx.finalContext.summary, summaryCovers: ctx.finalContext.summaryCovers, summaryHash: ctx.finalContext.summaryHash, ...revisionBudget, maxInputTokens: revisionBudget.maxInputTokens - estimateTokens(revisionPrompt) });
                  const revised = await ctx.invokeStreamed(revisionModel, revisionPrompt, revisionBudget.maxOutputTokens, () => undefined, { history: revisionContext.history, summary: revisionContext.summary, skipHistoryTrim: true, enableTools: false, projectRoot: ctx.projectRoot, signal: ctx.controller.signal });
                  const revisionCost = costOf(revised.inputTokens, revised.outputTokens, revisionModel);
                  ctx.deps.observability.recordInvocationEnd(revisionInvocationId, revised.inputTokens, revised.outputTokens, revisionModel.costPer1kTokens, 'success');
                  const revisionIncomplete = limitedStop(revised.stopReason);
                  if (revisionIncomplete) {
                    // The original paid answer remains the usable result when revision stops early.
                    ctx.result = { ...ctx.result, stopReason: revised.stopReason };
                    if (revised.stopReason === 'budget_limit')
                      ctx.noteBudgetLimit(limitMessage('budget_limit')!);
                  }
                  else {
                    ctx.result = revised;
                    ctx.executionModel = revisionModel;
                    ctx.verification.revised = true;
                  }
                  revisionSpan.end({ status: revisionIncomplete ? 'failed' : 'success', error: limitMessage(revised.stopReason), inputTokens: revised.inputTokens, outputTokens: revised.outputTokens, cost: revisionCost, attributes: { stopReason: revised.stopReason, retainedOriginalAnswer: revisionIncomplete } });
                }
                catch (revisionError) {
                  const message = revisionError instanceof Error ? revisionError.message : String(revisionError);
                  const usage = errorUsage(revisionError);
                  ctx.deps.observability.recordInvocationEnd(revisionInvocationId, usage.inputTokens, usage.outputTokens, revisionModel.costPer1kTokens, 'failure', message);
                  revisionSpan.end({ status: 'failed', error: message, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost: costOf(usage.inputTokens, usage.outputTokens, revisionModel) });
                  if (ctx.deps.controller.signal.aborted)
                    throw new Error('任务已取消');
                }
              }
              catch (revisionError) {
                const message = revisionError instanceof Error ? revisionError.message : String(revisionError);
                revisionSpan.end({ status: 'failed', error: message });
                if (ctx.deps.controller.signal.aborted)
                  throw new Error('任务已取消');
                if (!(revisionError instanceof BudgetExceededError))
                  throw revisionError;
              }
            }
            verificationSpan.end({ inputTokens: verified.inputTokens, outputTokens: verified.outputTokens, cost: verified.cost, attributes: { approved: ctx.verification.approved, score: ctx.verification.score, issues: ctx.verification.issueCount, revised: ctx.verification.revised, auditModelId: ctx.verification.auditModelId } });
          }
          else {
            ctx.deps.observability.recordInvocationEnd(verificationInvocationId, 0, 0, verifierModel.costPer1kTokens, 'failure', 'empty verification');
            verificationSpan.end({ status: 'failed', error: 'empty verification' });
          }
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.deps.observability.recordInvocationEnd(verificationInvocationId, 0, 0, verifierModel.costPer1kTokens, 'failure', message);
          verificationSpan.end({ status: 'failed', error: message });
          if (ctx.deps.controller.signal.aborted)
            throw new Error('任务已取消');
        }
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        verificationSpan.end({ status: 'failed', error: message });
        if (ctx.deps.controller.signal.aborted)
          throw new Error('任务已取消');
      }
    }
  }
}
