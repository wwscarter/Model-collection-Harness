import type { assembleContext, ContextTurn } from '@core/context/ContextAssembler';
import { assertPromptFits, modelContextBudget } from '@core/context/ContextBudget';
import type { RoutingFeedback } from '@core/growth/GrowthEngine';
import type { retrieveMemories } from '@core/memory/MemoryRetriever';
import type { ModelConfig } from '@core/models/ModelConfig';
import { hasUsableCredentials } from '@core/models/ModelConfig';
import type { snapshotModel } from '@core/models/ModelSnapshot';
import type { ModelInvocation } from '@core/observability/ObservabilityEngine';
import type { ProjectContextResult } from '@core/project/ProjectContext';
import { createProvider as createProviderImpl, type ModelProvider, type ModelResponse } from '@core/providers/ModelProvider';
import type { RoutingDecision } from '@core/routing/AgentRouter';
import type { ModelRequestEstimate, ModelUsage } from '@core/routing/ModelUsage';
import type { OrchestrationPlan } from '@core/routing/Orchestrator';
import type { RoutingSettings } from '@core/routing/RoutingSettings';
import { DEFAULT_ROUTING_SETTINGS } from '@core/routing/RoutingSettings';
import { BudgetExceededError, RunBudget } from '@core/routing/RunBudget';
import { awaitWithSignal } from '@core/tools/awaitWithSignal';
import type { TraceSpanHandle } from '@core/trace/TraceRecorder';
import type { RunStatus } from '@core/trace/types';
import { randomUUID } from 'node:crypto';
import type { ToolEvent } from '../AgentRuntime';
import type { buildExecutionPlan } from '../RunOrchestrator';
import { costOf, estimateTokens, sanitizeHistory } from './runHelpers';
import type { InvokeStreamed, RunDependencies, RunEmit, RunRequest } from './RunTypes';

export interface RunContext {
  request: RunRequest;
  deps: RunDependencies;
  emit: RunEmit;
  sessionId: string;
  runId: string;
  taskId: string;
  assistantMessageId: string;
  history: ContextTurn[];
  enableTools: boolean;
  toolCalls: ToolEvent[];
  traceFinished: boolean;
  traceStatus: RunStatus;
  traceError?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  budgetLimit?: { code: 'BUDGET_EXCEEDED'; message: string; estimatedCost: number; maxCostUsd: number };
  executionSpan: TraceSpanHandle;
  synthesisSpan?: TraceSpanHandle;
  agentSpans: Map<string, TraceSpanHandle>;
  toolSpans: Map<string, TraceSpanHandle>;
  finishTrace(status: RunStatus, error?: string): void;
  emitToolEvent(agentId: string | undefined, event: ToolEvent): void;
  collaboratorModels: ModelConfig[];
  trace: TraceSpanHandle;
  startedAt: number;
  budgetLimits: NonNullable<RoutingSettings['budget']>;
  runBudget: RunBudget;
  noteBudgetLimit(message: string): void;
  deadline: AbortController;
  deadlineTimer: ReturnType<typeof setTimeout>;
  controller: { signal: AbortSignal };
  cancellationError(): Error;
  projectRoot?: string;
  memory?: ReturnType<typeof retrieveMemories>;
  projectContext?: ProjectContextResult;
  contextPrompt: string;
  storedSummary: ReturnType<RunDependencies['summaries']['getSummary']>;
  priorContext?: string;
  pinned?: ModelConfig;
  routeSpan: TraceSpanHandle;
  decision: RoutingDecision;
  model: ModelConfig;
  orchestration?: OrchestrationPlan;
  planningModelId?: string;
  executionPlan: ReturnType<typeof buildExecutionPlan>;
  taskParts: string[];
  buildTaskPrompt(parts: string[]): string;
  executionCandidates: ModelConfig[];
  executionContextBudget: ReturnType<typeof modelContextBudget>;
  promptAllowance(basePrompt: string, maxInputTokens: number): number;
  contextAssembly: ReturnType<typeof assembleContext>;
  executionModel: ModelConfig;
  metrics?: ModelInvocation;
  fallbackAttempts: string[];
  traceAttempts: Array<{ index: number; status: 'success' | 'failed'; modelSnapshot: ReturnType<typeof snapshotModel>; error?: string; inputTokens?: number; outputTokens?: number; estimatedCost?: number }>;
  result: ModelResponse;
  agentReports: Array<{ modelName: string; content: string; stopReason?: string }>;
  failedAgentCount: number;
  agentMessages: Array<{ id: string; modelId: string; modelName: string; status: 'queued' | 'running' | 'completed' | 'failed'; content: string; error?: string; stopReason?: string }>;
  finalContext: ReturnType<typeof assembleContext>;
  verification?: { modelId: string; approved: boolean; score: number; issueCount: number; revised: boolean; auditModelId?: string };
  invokeStreamed: InvokeStreamed;
  createProvider(model: ModelConfig): ModelProvider;
  recordGrowth(feedback: RoutingFeedback): void;
}

/** Create the state and services shared by the stages of one run. */
export function createRunContext(request: RunRequest, deps: RunDependencies, emit: RunEmit): RunContext {
  const ctx = { request, deps, emit } as RunContext;
  const reservations = new Map<symbol, number>();
  const accountUsage = (model: ModelConfig, usage: ModelUsage) => {
    const cost = costOf(usage.inputTokens, usage.outputTokens, model);
    ctx.runBudget.add({ cost, tokens: usage.inputTokens + usage.outputTokens });
    ctx.totalInputTokens += usage.inputTokens;
    ctx.totalOutputTokens += usage.outputTokens;
    ctx.totalCost += cost;
  };
  const reserveRequest = (lease: symbol, model: ModelConfig, estimate: ModelRequestEstimate): {
    maxOutputTokens: number;
  } => {
    reservations.delete(lease);
    const held = [...reservations.values()].reduce((sum, value) => sum + value, 0);
    const maxOutputTokens = ctx.runBudget.capOutputTokens(estimate.estimatedInputTokens, estimate.maxOutputTokens, model.costPer1kTokens, held);
    reservations.set(lease, (estimate.estimatedInputTokens * model.costPer1kTokens.input + maxOutputTokens * model.costPer1kTokens.output) / 1000);
    return { maxOutputTokens };
  };
  ctx.invokeStreamed = async (model, prompt, maxTokens, onDelta, options) => {
    options?.signal?.throwIfAborted();
    const lease = Symbol(model.id);
    const observed = { inputTokens: 0, outputTokens: 0 };
    let streamedContent = '';
    try {
      const initial = reserveRequest(lease, model, { estimatedInputTokens: estimateTokens(prompt) + estimateTokens(JSON.stringify(options?.history ?? [])) + (options?.summary ? estimateTokens(options.summary) : 0), maxOutputTokens: maxTokens });
      const result = await awaitWithSignal(ctx.deps.invokeStreamed(model, prompt, initial.maxOutputTokens, (delta) => {
        if (!options?.signal?.aborted) {
          streamedContent += delta;
          onDelta(delta);
        }
      }, {
        ...options,
        beforeModelRequest: (estimate) => reserveRequest(lease, model, estimate),
        onUsage: (usage) => {
          reservations.delete(lease);
          observed.inputTokens += usage.inputTokens;
          observed.outputTokens += usage.outputTokens;
          accountUsage(model, usage);
          options?.onUsage?.(usage);
          ctx.runBudget.assertAvailable();
        },
      }), options?.signal);
      // Test/provider adapters without progress hooks still account usage once at completion.
      accountUsage(model, { inputTokens: Math.max(0, result.inputTokens - observed.inputTokens), outputTokens: Math.max(0, result.outputTokens - observed.outputTokens) });
      return result;
    }
    catch (error) {
      const limit = options?.signal?.reason instanceof BudgetExceededError ? options.signal.reason : error instanceof BudgetExceededError ? error : undefined;
      if (limit && !ctx.deps.controller.signal.aborted) {
        return { content: streamedContent.trim() ? streamedContent : '本轮因运行预算停止，尚未生成完整回答。', ...observed, modelId: model.id, stopReason: 'budget_limit', budgetLimitReason: limit.message };
      }
      if (error instanceof Error)
        Object.assign(error, { modelUsage: { ...observed } });
      throw error;
    }
    finally {
      reservations.delete(lease);
    }
  };
  ctx.createProvider = (model: ModelConfig): ModelProvider => {
    const provider = (ctx.deps.createProvider ?? createProviderImpl)(model);
    return {
      modelId: provider.modelId, invoke: async (prompt, options) => {
        const budget = modelContextBudget([model], options?.maxTokens ?? model.maxTokens);
        assertPromptFits(prompt, budget);
        options?.signal?.throwIfAborted();
        const lease = Symbol(model.id);
        try {
          const capped = reserveRequest(lease, model, { estimatedInputTokens: estimateTokens(prompt), maxOutputTokens: budget.maxOutputTokens });
          ctx.deps.quota.reserve(model);
          const result = await awaitWithSignal(provider.invoke(prompt, { ...options, maxTokens: capped.maxOutputTokens }), options?.signal);
          accountUsage(model, result);
          return result;
        }
        finally {
          reservations.delete(lease);
        }
      }
    };
  };
  ctx.recordGrowth = (feedback: RoutingFeedback) => {
    try {
      ctx.deps.growth.recordFeedback(feedback);
    }
    catch (error) {
      console.error('Growth feedback failed', error);
    }
  };
  if (!ctx.request || typeof ctx.request.prompt !== 'string' || !ctx.request.prompt.trim())
    throw new Error('任务描述不能为空');
  if (ctx.request.prompt.length > 200000)
    throw new Error('任务描述过长');
  if (ctx.request.taskId !== undefined && typeof ctx.request.taskId !== 'string')
    throw new Error('任务 ID 无效');
  if (ctx.request.sessionId !== undefined && typeof ctx.request.sessionId !== 'string')
    throw new Error('会话 ID 无效');
  if (ctx.request.runId !== undefined && typeof ctx.request.runId !== 'string')
    throw new Error('运行 ID 无效');
  ctx.sessionId = ctx.request.sessionId || ctx.request.taskId || randomUUID();
  ctx.runId = ctx.request.runId || randomUUID();
  ctx.taskId = ctx.request.taskId || ctx.sessionId;
  ctx.assistantMessageId = ctx.request.assistantMessageId || `${ctx.runId}-assistant`;
  ctx.history = sanitizeHistory(ctx.request.history);
  ctx.enableTools = ctx.request.enableTools !== false;
  ctx.toolCalls = [];
  ctx.traceFinished = false;
  ctx.traceStatus = 'success';
  ctx.totalInputTokens = 0;
  ctx.totalOutputTokens = 0;
  ctx.totalCost = 0;
  ctx.agentSpans = new Map<string, TraceSpanHandle>();
  ctx.toolSpans = new Map<string, TraceSpanHandle>();
  ctx.finishTrace = (status: RunStatus, error?: string) => {
    if (ctx.traceFinished)
      return;
    ctx.traceFinished = true;
    ctx.deps.traces.finishRun(ctx.runId, { status, error, inputTokens: ctx.totalInputTokens, outputTokens: ctx.totalOutputTokens, cost: ctx.totalCost });
  };
  ctx.emitToolEvent = (agentId: string | undefined, event: ToolEvent) => {
    if (!agentId) {
      const index = ctx.toolCalls.findIndex((call) => call.toolCallId === event.toolCallId);
      const merged = index >= 0 ? { ...ctx.toolCalls[index], ...event, args: event.args ?? ctx.toolCalls[index].args } : event;
      if (index >= 0)
        ctx.toolCalls[index] = merged;
      else
        ctx.toolCalls.push(merged);
    }
    if (event.status === 'running') {
      const parent = agentId ? ctx.agentSpans.get(agentId) : ctx.executionSpan;
      if (parent)
        ctx.toolSpans.set(event.toolCallId, parent.child('tool', event.toolName, { toolCallId: event.toolCallId }));
    }
    else {
      const span = ctx.toolSpans.get(event.toolCallId);
      const metadata = event.toolName === 'run_command' && event.details && typeof event.details === 'object'
        ? event.details as { sandbox?: Record<string, unknown>; policy?: { category?: string; decision?: string; outsideProject?: boolean } } : undefined;
      span?.end({
        status: event.status === 'failed' ? 'failed' : 'success',
        error: event.status === 'failed' ? event.summary?.slice(0, 500) || 'Tool failed without an available failure summary' : undefined,
        attributes: {
          tool: event.toolName, durationMs: event.durationMs, summaryChars: event.summary?.length ?? 0,
          ...(metadata?.sandbox ? { sandbox: metadata.sandbox } : {}),
          ...(metadata?.policy ? { policy: { category: metadata.policy.category, decision: metadata.policy.decision, outsideProject: metadata.policy.outsideProject } } : {}),
        },
      });
      ctx.toolSpans.delete(event.toolCallId);
    }
    ctx.emit('session:tool-call', { sessionId: ctx.sessionId, taskId: ctx.taskId, runId: ctx.runId, assistantMessageId: ctx.assistantMessageId, agentId, ...event, details: undefined });
  };
  const collaboratorIds = [...new Set(ctx.request.collaboratorModelIds ?? [])];
  if (collaboratorIds.length === 1 || collaboratorIds.length > 4)
    throw new Error('并行子智能体需要选择 2–4 个不同的模型。');
  ctx.collaboratorModels = collaboratorIds.map((id) => {
    const candidate = ctx.deps.models.getModel(id);
    if (!candidate || !candidate.enabled || !hasUsableCredentials(candidate))
      throw new Error('子智能体只能使用已启用且配置了可用 API Key 的模型，请检查模型配置。');
    if (!ctx.deps.quota.isAvailable(candidate))
      throw new Error(`模型「${candidate.name}」已达到速率或每日配额，请稍后再试`);
    return candidate;
  });
  ctx.trace = ctx.deps.traces.startRun({ runId: ctx.runId, sessionId: ctx.sessionId, taskType: ctx.request.taskType, complexity: ctx.request.complexity });
  ctx.startedAt = Date.now();
  ctx.budgetLimits = ctx.deps.routingSettings?.budget ?? DEFAULT_ROUTING_SETTINGS.budget!;
  const { maxDurationMs } = ctx.budgetLimits;
  ctx.runBudget = new RunBudget({ maxCost: ctx.budgetLimits.maxCostUsd, maxDurationMs });
  ctx.noteBudgetLimit = (message: string) => { ctx.budgetLimit = { code: 'BUDGET_EXCEEDED', message, estimatedCost: ctx.totalCost, maxCostUsd: ctx.budgetLimits.maxCostUsd }; };
  ctx.trace.setAttributes({ budget: { ...ctx.budgetLimits, pricingBasis: 'configured-token-rates' } });
  ctx.deadline = new AbortController();
  ctx.deadlineTimer = setTimeout(() => ctx.deadline.abort(new BudgetExceededError(`本轮运行已超过 ${Math.round(maxDurationMs / 1000)} 秒预算`)), maxDurationMs);
  ctx.deadlineTimer.unref?.();
  ctx.controller = { signal: AbortSignal.any([ctx.deps.controller.signal, ctx.deadline.signal]) };
  ctx.cancellationError = () => ctx.deps.controller.signal.aborted
    ? new Error('任务已取消')
    : new BudgetExceededError(`本轮运行已超过 ${Math.round(maxDurationMs / 1000)} 秒预算`);
  ctx.projectRoot = ctx.deps.projectContext.getRoot();
  return ctx;
}
