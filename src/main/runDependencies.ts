import type { ModelConfig } from '@core/models/ModelConfig';
import { hasUsableCredentials } from '@core/models/ModelConfig';
import type { ModelResponse } from '@core/providers/ModelProvider';
import type { RunDependencies } from '@core/agent/RunCoordinator';
import type { MainContext } from './MainContext';

function estimateTokens(value: string): number { return Math.max(1, Math.ceil(value.length / 4)); }

async function invokeStreamed(ctx: MainContext, model: ModelConfig, prompt: string, maxTokens: number, onDelta: (delta: string) => void, options: NonNullable<Parameters<RunDependencies['invokeStreamed']>[4]> = {}): Promise<ModelResponse> {
  if (options.signal?.aborted) throw new Error('任务已取消');
  // Never turn a missing credential into a plausible-looking "demo" answer:
  // the router filters these models, and a direct call fails loudly instead.
  if (!hasUsableCredentials(model)) throw new Error(`模型「${model.name}」尚未配置 API Key，无法执行任务`);
  const changedPaths = new Map<string, string>();
  const result = await ctx.agentRuntime.run({
    model, prompt, history: options.history, summary: options.summary, skipHistoryTrim: options.skipHistoryTrim, maxTokens: Math.min(model.maxTokens ?? maxTokens, maxTokens),
    enableTools: options.enableTools !== false,
    projectRoot: options.projectRoot, projectAccess: options.projectAccess, signal: options.signal, onTextDelta: onDelta,
    onToolEvent: (event) => {
      if (['write', 'edit'].includes(event.toolName)) {
        const file = (event.args as { path?: unknown } | undefined)?.path;
        if (event.status === 'running' && typeof file === 'string') changedPaths.set(event.toolCallId, file);
        const changed = changedPaths.get(event.toolCallId);
        if (event.status !== 'running') {
          changedPaths.delete(event.toolCallId);
          if (event.status === 'completed' && changed && options.projectRoot) {
            void ctx.codebase.refresh(options.projectRoot, [changed], options.signal).catch((error) => { if (!options.signal?.aborted) console.warn('代码符号增量更新失败', error); });
          }
        }
      }
      options.onToolEvent?.(event);
    },
    beforeModelRequest: options.beforeModelRequest, onUsage: options.onUsage,
  });
  return { content: result.content, inputTokens: result.inputTokens ?? estimateTokens(prompt), outputTokens: result.outputTokens ?? estimateTokens(result.content), modelId: model.id, stopReason: result.stopReason, budgetLimitReason: result.budgetLimitReason };
}

export function createRunDependencies(ctx: MainContext, controller: AbortController, projectContext: RunDependencies['projectContext']): RunDependencies {
  const { registry, routingService, routingLearning, routingPolicy, modelQuota, traceRecorder, observability, growth, codeAuditor, auditLog, memoryStore, sessionStorage } = ctx;
  return {
    models: registry,
    routing: routingPolicy,
    routingSettings: routingService.getConfiguration().settings,
    onClassification: (observation) => routingLearning.observe(observation),
    quota: modelQuota,
    traces: traceRecorder,
    observability,
    growth,
    codeAuditor,
    auditLog,
    memory: memoryStore,
    summaries: sessionStorage,
    projectContext,
    invokeStreamed: (model, prompt, maxTokens, onDelta, options) => invokeStreamed(ctx, model, prompt, maxTokens, onDelta, options),
    controller,
  };
}

