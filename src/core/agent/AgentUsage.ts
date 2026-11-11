import type { ModelUsage } from '@core/routing/ModelUsage';
import { BudgetExceededError } from '@core/routing/RunBudget';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AgentRunRequest, RunUsageState } from './AgentRuntimeTypes';

/** Account for every SDK response exactly once, including repairs and compaction. */
export function installUsageAccounting(session: AgentSession, request: AgentRunRequest, mapping: { temperature?: number }, runTimeoutMs?: number): RunUsageState {
  const usageState: RunUsageState = {
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, seen: new WeakSet(),
    report: (usage) => {
      if (usageState.seen.has(usage)) return;
      usageState.seen.add(usage);
      const count = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;
      const next: Required<ModelUsage> = {
        inputTokens: count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite), outputTokens: count(usage.output),
        cacheReadTokens: count(usage.cacheRead), cacheWriteTokens: count(usage.cacheWrite),
      };
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) usageState.usage[key] += next[key];
      try { request.onUsage?.(next); } catch (error) { stopAfterCallback(error); }
    },
  };
  const stopAfterCallback = (error: unknown) => {
    if (error instanceof BudgetExceededError) usageState.budgetError = error;
    else usageState.callbackError = error instanceof Error ? error : new Error(String(error));
    session.setAutoRetryEnabled(false);
    session.setActiveToolsByName([]);
  };
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = async (requestModel, context, options) => {
    request.signal?.throwIfAborted();
    if (usageState.callbackError) throw usageState.callbackError;
    if (usageState.budgetError) throw usageState.budgetError;
    const requested = options?.maxTokens ?? requestModel.maxTokens;
    let maxTokens = requested;
    try {
      const gate = request.beforeModelRequest?.({ estimatedInputTokens: Math.max(1, Math.ceil(JSON.stringify(context).length / 4)), maxOutputTokens: requested });
      if (gate) {
        if (!Number.isSafeInteger(gate.maxOutputTokens) || gate.maxOutputTokens < 1) throw new Error('模型请求输出上限必须是正整数');
        maxTokens = Math.min(requested, gate.maxOutputTokens);
      }
    } catch (error) { stopAfterCallback(error); throw error; }
    request.signal?.throwIfAborted();
    const source = await stream(requestModel, context, {
      ...options, maxTokens,
      ...(mapping.temperature !== undefined ? { temperature: mapping.temperature } : {}),
      ...((options?.timeoutMs ?? runTimeoutMs) ? { timeoutMs: Math.min(options?.timeoutMs ?? Infinity, runTimeoutMs ?? Infinity) } : {}),
    });
    const forwarded = createAssistantMessageEventStream();
    // Compaction consumes .result() without message_end; record every actual response here too.
    void (async () => {
      let partial: AssistantMessage | undefined;
      let ended = false;
      try {
        for await (const event of source) {
          if ('partial' in event) partial = event.partial;
          if (event.type === 'done' || event.type === 'error') {
            const message = event.type === 'done' ? event.message : event.error;
            usageState.report(message.usage);
            ended = true;
          }
          forwarded.push(event);
        }
        if (!ended) {
          const message = await source.result();
          usageState.report(message.usage);
          forwarded.end(message);
        }
      } catch (error) {
        const message: AssistantMessage = {
          role: 'assistant', content: partial?.content ?? [], api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
          timestamp: Date.now(), stopReason: request.signal?.aborted ? 'aborted' : 'error', errorMessage: error instanceof Error ? error.message : String(error),
          usage: partial?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        usageState.report(message.usage);
        forwarded.push({ type: 'error', reason: message.stopReason === 'aborted' ? 'aborted' : 'error', error: message });
      }
    })();
    return forwarded;
  };
  return usageState;
}
