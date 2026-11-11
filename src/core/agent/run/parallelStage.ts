import { assembleContext } from '@core/context/ContextAssembler';
import { fitPromptParts, modelContextBudget } from '@core/context/ContextBudget';
import { snapshotModel } from '@core/models/ModelSnapshot';
import { buildParallelAgentPrompt, parallelAgentPerspective, parallelAgentRole, runParallelAgents } from '@core/routing/ModelCollaboration';
import { buildSubagentInstruction } from '@core/routing/Orchestrator';
import type { AgentActivity } from '../RunActivity';
import type { RunContext } from './RunContext';
import { costOf, errorUsage, estimateTokens, limitedStop, limitMessage, PARTIAL_AGENT_NOTICE } from './runHelpers';

/** Collect read-only collaborator reports before synthesis. */
export async function parallelStage(ctx: RunContext): Promise<void> {
  ctx.synthesisSpan = ctx.collaboratorModels.length ? ctx.trace.child('synthesis', 'synthesis', { agents: ctx.collaboratorModels.length }) : undefined;
  ctx.executionSpan = (ctx.synthesisSpan ?? ctx.trace).child('model', 'execution', { modelId: ctx.model.id, modelSnapshot: snapshotModel(ctx.model), role: 'executor' });
  ctx.agentReports = [];
  ctx.failedAgentCount = 0;
  ctx.agentMessages = ctx.collaboratorModels.map((agentModel, index) => {
    const subagent = ctx.orchestration?.subagents.find((candidate) => candidate.modelId === agentModel.id);
    return { id: `${ctx.assistantMessageId}-agent-${index + 1}`, modelId: agentModel.id, actualModelId: agentModel.modelId, modelName: agentModel.name,
      role: subagent?.role?.slice(0, 100) ?? parallelAgentRole(index), task: (subagent?.instruction ?? parallelAgentPerspective(index)).slice(0, 4000), status: 'queued', content: '', tools: [] };
  });
  const publish = (agent: AgentActivity, delta?: string) => ctx.emit('session:agent-update', {
    sessionId: ctx.sessionId, taskId: ctx.taskId, runId: ctx.runId, assistantMessageId: ctx.assistantMessageId, agentId: agent.id, ...agent,
    tools: agent.tools?.map((tool) => ({ ...tool })), ...(delta === undefined ? {} : { delta }),
  });
  // Publish the whole queued roster before any collaborator can start or fail.
  for (const agent of ctx.agentMessages) publish(agent);
  if (!ctx.collaboratorModels.length) return;
  const agentResults = await runParallelAgents(ctx.collaboratorModels, async (agentModel, index) => {
    const agent = ctx.agentMessages[index], agentId = agent.id;
    const agentSpan = ctx.trace.child('model', 'collaborator', { agentId, modelId: agentModel.id, modelSnapshot: snapshotModel(agentModel), role: agent.role, task: agent.task });
    ctx.agentSpans.set(agentId, agentSpan);
    let agentInvocationId: string | undefined;
    let agentContent = '';
    let startedMs: number | undefined;
    const settleTools = () => {
      for (const tool of agent.tools ?? []) {
        if (tool.status === 'running') ctx.emitToolEvent(agentId, { toolCallId: tool.id, toolName: tool.toolName, status: 'failed', summary: tool.summary ?? '子智能体已结束，工具未返回完成状态', durationMs: tool.durationMs });
      }
    };
    const finish = (status: AgentActivity['status'], error?: string, stopReason?: string) => {
      settleTools();
      Object.assign(agent, { status, content: agentContent.slice(0, 40000), finishedAt: new Date().toISOString(), durationMs: startedMs === undefined ? 0 : Date.now() - startedMs,
        ...(error ? { error: error.slice(0, 2000) } : {}), ...(stopReason ? { stopReason } : {}) });
      publish(agent);
    };
    try {
      if (ctx.controller.signal.aborted) throw ctx.cancellationError();
      ctx.runBudget.assertAvailable();
      ctx.deps.quota.reserve(agentModel);
      startedMs = Date.now();
      Object.assign(agent, { status: 'running', startedAt: new Date(startedMs).toISOString() });
      agentInvocationId = ctx.deps.observability.recordInvocationStart(ctx.runId, agentModel.id);
      publish(agent);
      const subagent = ctx.orchestration?.subagents.find((candidate) => candidate.modelId === agentModel.id);
      const agentBudget = modelContextBudget([agentModel], 1800);
      const buildAgentPrompt = (parts: string[]) => subagent ? buildSubagentInstruction(ctx.buildTaskPrompt(parts), subagent) : buildParallelAgentPrompt(ctx.buildTaskPrompt(parts), index);
      const agentPrompt = fitPromptParts(buildAgentPrompt, ctx.taskParts, ctx.promptAllowance(buildAgentPrompt(['', '']), agentBudget.maxInputTokens));
      const agentContext = assembleContext({ history: ctx.history, summary: ctx.contextAssembly.summary, summaryCovers: ctx.contextAssembly.summaryCovers, summaryHash: ctx.contextAssembly.summaryHash, ...agentBudget, maxInputTokens: agentBudget.maxInputTokens - estimateTokens(agentPrompt) });
      const agentResult = await ctx.invokeStreamed(agentModel, agentPrompt, agentBudget.maxOutputTokens, (delta) => {
        agentContent += delta;
        agent.content = agentContent.slice(0, 40000);
        publish(agent, delta);
      }, { history: agentContext.history, summary: agentContext.summary, skipHistoryTrim: true, enableTools: ctx.enableTools, projectRoot: ctx.projectRoot, projectAccess: 'read', agentId, signal: ctx.controller.signal, onToolEvent: (event) => ctx.emitToolEvent(agentId, event) });
      ctx.deps.observability.recordInvocationEnd(agentInvocationId, agentResult.inputTokens, agentResult.outputTokens, agentModel.costPer1kTokens, 'success');
      const limited = limitedStop(agentResult.stopReason);
      const error = agentResult.stopReason === 'tool_limit' ? PARTIAL_AGENT_NOTICE : limited ? limitMessage(agentResult.stopReason) : undefined;
      agentSpan.end({ status: limited ? 'failed' : 'success', error, inputTokens: agentResult.inputTokens, outputTokens: agentResult.outputTokens, cost: costOf(agentResult.inputTokens, agentResult.outputTokens, agentModel), attributes: { stopReason: agentResult.stopReason } });
      agentContent = agentResult.content;
      finish(limited ? 'failed' : 'completed', error, agentResult.stopReason);
      return { modelName: agentModel.name, content: agentResult.content, stopReason: agentResult.stopReason };
    } catch (agentError) {
      const message = agentError instanceof Error ? agentError.message : String(agentError);
      const usage = errorUsage(agentError);
      const cancelled = ctx.deps.controller.signal.aborted;
      if (agentInvocationId) ctx.deps.observability.recordInvocationEnd(agentInvocationId, usage.inputTokens, usage.outputTokens, agentModel.costPer1kTokens, 'failure', message);
      agentSpan.end({ status: cancelled ? 'cancelled' : 'failed', error: message, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost: costOf(usage.inputTokens, usage.outputTokens, agentModel) });
      finish(cancelled ? 'cancelled' : 'failed', message);
      throw agentError;
    }
  });
  ctx.agentReports = agentResults.flatMap((agentResult) => agentResult.status === 'fulfilled' ? [agentResult.value] : []);
  ctx.failedAgentCount = agentResults.length - ctx.agentReports.length;
}
