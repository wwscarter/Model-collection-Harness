import { assembleContext } from '@core/context/ContextAssembler';
import { fitPromptParts, modelContextBudget } from '@core/context/ContextBudget';
import { snapshotModel } from '@core/models/ModelSnapshot';
import { buildParallelAgentPrompt, runParallelAgents } from '@core/routing/ModelCollaboration';
import { buildSubagentInstruction } from '@core/routing/Orchestrator';
import type { RunContext } from './RunContext';
import { costOf, errorUsage, estimateTokens, limitedStop, limitMessage, PARTIAL_AGENT_NOTICE } from './runHelpers';

/** Collect read-only collaborator reports before synthesis. */
export async function parallelStage(ctx: RunContext): Promise<void> {
  ctx.synthesisSpan = ctx.collaboratorModels.length ? ctx.trace.child('synthesis', 'synthesis', { agents: ctx.collaboratorModels.length }) : undefined;
  ctx.executionSpan = (ctx.synthesisSpan ?? ctx.trace).child('model', 'execution', { modelId: ctx.model.id, modelSnapshot: snapshotModel(ctx.model), role: 'executor' });
  ctx.agentReports = [];
  ctx.failedAgentCount = 0;
  ctx.agentMessages = ctx.collaboratorModels.map((agentModel, index) => ({
    id: `${ctx.assistantMessageId}-agent-${index + 1}`,
    modelId: agentModel.id,
    modelName: agentModel.name,
    status: 'queued' as 'queued' | 'running' | 'completed' | 'failed',
    content: '',
    error: undefined as string | undefined,
    stopReason: undefined as string | undefined,
  }));
  if (ctx.collaboratorModels.length) {
    const agentResults = await runParallelAgents(ctx.collaboratorModels, async (agentModel, index) => {
      const agentId = `${ctx.assistantMessageId}-agent-${index + 1}`;
      ctx.runBudget.assertAvailable();
      const agentSpan = ctx.trace.child('model', 'collaborator', { agentId, modelId: agentModel.id, modelSnapshot: snapshotModel(agentModel), role: 'analyst' });
      ctx.agentSpans.set(agentId, agentSpan);
      const agentInvocationId = ctx.deps.observability.recordInvocationStart(ctx.runId, agentModel.id);
      let agentContent = '';
      ctx.agentMessages[index].status = 'running';
      ctx.emit('session:agent-update', { sessionId: ctx.sessionId, taskId: ctx.taskId, assistantMessageId: ctx.assistantMessageId, agentId, modelId: agentModel.id, modelName: agentModel.name, status: 'running' });
      try {
        ctx.deps.quota.reserve(agentModel);
        const subagent = ctx.orchestration?.subagents.find((candidate) => candidate.modelId === agentModel.id);
        const agentBudget = modelContextBudget([agentModel], 1800);
        const buildAgentPrompt = (parts: string[]) => subagent ? buildSubagentInstruction(ctx.buildTaskPrompt(parts), subagent) : buildParallelAgentPrompt(ctx.buildTaskPrompt(parts), index);
        const agentPrompt = fitPromptParts(buildAgentPrompt, ctx.taskParts, ctx.promptAllowance(buildAgentPrompt(['', '']), agentBudget.maxInputTokens));
        const agentContext = assembleContext({ history: ctx.history, summary: ctx.contextAssembly.summary, summaryCovers: ctx.contextAssembly.summaryCovers, summaryHash: ctx.contextAssembly.summaryHash, ...agentBudget, maxInputTokens: agentBudget.maxInputTokens - estimateTokens(agentPrompt) });
        const agentResult = await ctx.invokeStreamed(agentModel, agentPrompt, agentBudget.maxOutputTokens, (delta) => {
          agentContent += delta;
          ctx.agentMessages[index].content = agentContent;
          ctx.emit('session:agent-update', { sessionId: ctx.sessionId, taskId: ctx.taskId, assistantMessageId: ctx.assistantMessageId, agentId, modelId: agentModel.id, status: 'running', delta });
        }, { history: agentContext.history, summary: agentContext.summary, skipHistoryTrim: true, enableTools: ctx.enableTools, projectRoot: ctx.projectRoot, projectAccess: 'read', agentId, signal: ctx.controller.signal, onToolEvent: (event) => ctx.emitToolEvent(agentId, event) });
        ctx.deps.observability.recordInvocationEnd(agentInvocationId, agentResult.inputTokens, agentResult.outputTokens, agentModel.costPer1kTokens, 'success');
        const agentCost = costOf(agentResult.inputTokens, agentResult.outputTokens, agentModel);
        const limited = limitedStop(agentResult.stopReason);
        const status = limited ? 'failed' : 'completed';
        const error = agentResult.stopReason === 'tool_limit' ? PARTIAL_AGENT_NOTICE : limited ? limitMessage(agentResult.stopReason) : undefined;
        agentSpan.end({ status: limited ? 'failed' : 'success', error, inputTokens: agentResult.inputTokens, outputTokens: agentResult.outputTokens, cost: agentCost, attributes: { stopReason: agentResult.stopReason } });
        ctx.agentMessages[index].status = status;
        ctx.agentMessages[index].content = agentResult.content;
        ctx.agentMessages[index].error = error;
        ctx.agentMessages[index].stopReason = agentResult.stopReason;
        ctx.emit('session:agent-update', { sessionId: ctx.sessionId, taskId: ctx.taskId, assistantMessageId: ctx.assistantMessageId, agentId, modelId: agentModel.id, modelName: agentModel.name, status, content: agentResult.content, error, stopReason: agentResult.stopReason });
        return { modelName: agentModel.name, content: agentResult.content, stopReason: agentResult.stopReason };
      }
      catch (agentError) {
        const message = agentError instanceof Error ? agentError.message : String(agentError);
        const usage = errorUsage(agentError);
        ctx.deps.observability.recordInvocationEnd(agentInvocationId, usage.inputTokens, usage.outputTokens, agentModel.costPer1kTokens, 'failure', message);
        agentSpan.end({ status: 'failed', error: message, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost: costOf(usage.inputTokens, usage.outputTokens, agentModel) });
        ctx.agentMessages[index].status = 'failed';
        ctx.agentMessages[index].content = agentContent;
        Object.assign(ctx.agentMessages[index], { error: message });
        ctx.emit('session:agent-update', { sessionId: ctx.sessionId, taskId: ctx.taskId, assistantMessageId: ctx.assistantMessageId, agentId, modelId: agentModel.id, modelName: agentModel.name, status: 'failed', content: agentContent, error: message });
        throw agentError;
      }
    });
    ctx.agentReports = agentResults.flatMap((agentResult) => agentResult.status === 'fulfilled' ? [agentResult.value] : []);
    ctx.failedAgentCount = agentResults.length - ctx.agentReports.length;
  }
}
