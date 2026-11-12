import { BudgetExceededError } from '@core/routing/RunBudget';
import type { ToolRuntime } from '@core/tools/ToolRuntime';
import { awaitWithSignal } from '@core/tools/awaitWithSignal';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { summarizeToolResult, textOf } from './AgentHistory';
import { type AgentRunRequest, type AgentRunResult, type AgentRuntimeOptions, type RunUsageState } from './AgentRuntimeTypes';

export async function driveAgentSession(session: AgentSession, request: AgentRunRequest, toolRuntime: ToolRuntime, usageState: RunUsageState, options: Pick<AgentRuntimeOptions, 'maxToolRounds'> & { beforeTurn?: () => Promise<void>; assertReady?: () => void }): Promise<AgentRunResult> {
  let content = '';
  // Text carried across automatic continuations when the model hits its per-response output cap.
  let carried = '';
  // The Pi session does not always put a length-truncated answer into `messages`.
  let lastStopReason: string | undefined;
  let toolCalls = 0;
  let toolRounds = 0;
  let toolLimitReached = false;
  let summaryCompleted = false;
  let limitDescription = '';
  const toolLabels = new Map<string, string>();
  const completedTools: string[] = [];
  const maxToolRounds = options.maxToolRounds ?? Number.POSITIVE_INFINITY;
  const finishTurn = session.agent.finishTurn;
  const beforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (call, signal) => {
    if (usageState.budgetError || usageState.callbackError) return { block: true, reason: '本轮模型请求已停止，不再执行工具。', terminate: true };
    if (toolLimitReached) return { block: true, reason: '工具额度已用尽，请只基于现有结果生成阶段性总结。', terminate: true };
    return beforeToolCall?.(call, signal);
  };
  // Keep the accumulated tool results and reserve one logical answer turn.
  // This does not reset tool counts or the existing run deadline.
  session.agent.finishTurn = async (turn, signal) => {
    lastStopReason = (turn.message as { stopReason?: string }).stopReason ?? lastStopReason;
    if (usageState.budgetError || usageState.callbackError) return { action: 'end' };
    const decision = await finishTurn?.(turn, signal);
    if (signal?.aborted || request.signal?.aborted || turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') return { action: 'end' };
    if (toolLimitReached) {
      summaryCompleted = !turn.toolResults.length && Boolean(textOf(turn.message).trim());
      return { action: 'end' };
    }
    if (decision?.action === 'end') return decision;
    if (turn.toolResults.length) toolRounds += 1;
    const budget = toolRuntime.getBudgetState();
    if (turn.toolResults.length && (toolRounds >= maxToolRounds || toolCalls >= budget.maxCalls || budget.exhaustedBy)) {
      toolLimitReached = true;
      limitDescription = toolRounds >= maxToolRounds ? `${maxToolRounds} 轮工具调用`
        : budget.exhaustedBy === 'output' ? `${budget.maxResultChars} 字符工具结果` : `${budget.maxCalls} 次工具调用`;
      session.setActiveToolsByName([]);
      session.setAutoRetryEnabled(false);
      await session.sendCustomMessage({
        customType: 'newai-tool-budget-summary', display: false,
        content: `本轮工具额度已用尽（${limitDescription}），工具现已关闭。请立即根据本轮已经获取的资料，用用户的语言给出阶段性分析。明确列出已确认的结论、已检查的文件或范围、仍未验证或未完成的事项，以及下一步最值得继续的内容。不要再次请求工具，不要只说“继续读取”，不要把未完成的项目分析称为已全部完成。如果资料不足，说明具体缺少什么，不要编造结论。`,
      }, { deliverAs: 'steer' });
      return { action: 'continue' };
    }
    return decision || undefined;
  };
  const onAbort = () => { void session.abort(); };
  request.signal?.addEventListener('abort', onAbort, { once: true });
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'message_end' && (event.message.role === 'assistant' || event.message.role === 'toolResult') && event.message.usage) {
      const usage = event.message.usage;
      // A rejected request gate creates a synthetic zero-usage error message in Pi.
      if ((!usageState.budgetError && !usageState.callbackError) || usage.input || usage.output || usage.cacheRead || usage.cacheWrite) usageState.report(usage);
    } else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      content += event.assistantMessageEvent.delta;
      request.onTextDelta?.(event.assistantMessageEvent.delta);
    } else if (event.type === 'message_start' && (event.message as { role?: string }).role === 'assistant' && content && !content.endsWith('\n')) {
      // A new assistant message after tool calls: keep paragraphs apart in the streamed text.
      content += '\n\n';
      request.onTextDelta?.('\n\n');
    } else if (event.type === 'tool_execution_start') {
      if (toolLimitReached) return;
      toolCalls += 1;
      const args = event.args as { path?: unknown; query?: unknown } | undefined;
      const label = typeof args?.path === 'string' ? args.path : typeof args?.query === 'string' ? args.query : '';
      toolLabels.set(event.toolCallId, `${event.toolName}${label ? `：${label.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
      request.onToolEvent?.({ toolCallId: event.toolCallId, toolName: event.toolName, status: 'running', args: event.args });
    } else if (event.type === 'tool_execution_end') {
      if (toolLimitReached) return;
      if (!event.isError) completedTools.push(toolLabels.get(event.toolCallId) ?? event.toolName);
      toolLabels.delete(event.toolCallId);
      request.onToolEvent?.({ toolCallId: event.toolCallId, toolName: event.toolName, status: event.isError ? 'failed' : 'completed', summary: summarizeToolResult(event.result), details: (event.result as { details?: unknown })?.details, durationMs: event.durationMs });
    }
  });
  try {
    await session.bindExtensions({ mode: 'print' });
    let prompt = request.prompt;
    let previousAnswer = '';
    while (true) {
      request.signal?.throwIfAborted();
      if (options.beforeTurn) await awaitWithSignal(options.beforeTurn(), request.signal);
      lastStopReason = undefined;
      let summaryFailed = false;
      try { await session.prompt(prompt, { expandPromptTemplates: false }); }
      catch (error) {
        if (request.signal?.aborted) throw error;
        if (!usageState.budgetError) {
          if (!toolLimitReached) throw error;
          summaryFailed = true;
        }
      }
      try { options.assertReady?.(); } catch (error) { if (error instanceof BudgetExceededError) usageState.budgetError = error; else throw error; }
      const stats = session.getSessionStats();
      const last = [...session.messages].reverse().find((message) => (message as { role?: string }).role === 'assistant') as { stopReason?: string; errorMessage?: string } | undefined;
      if (last?.stopReason === 'aborted' || request.signal?.aborted) throw new Error('任务已取消');
      if (usageState.callbackError) throw usageState.callbackError;
      if (last?.stopReason === 'error' && !toolLimitReached && !usageState.budgetError) throw new Error(last.errorMessage || '模型调用失败');
      const finalText = session.getLastAssistantText() ?? '';
      let answer = finalText.trim() ? finalText : content.trim() ? content : previousAnswer;
      const effectiveStopReason = last?.stopReason ?? lastStopReason;
      if (effectiveStopReason === 'length' && !usageState.budgetError && !toolLimitReached) {
        const addition = answer.trim();
        // Continue automatically instead of stopping the task at a per-response
        // token cap. Repeating the same text means no progress; stop in that case.
        if (addition && addition !== carried.trim()) {
          carried = carried ? carried + '\n\n' + addition : addition;
          previousAnswer = carried;
          content = '';
          prompt = '上一次回答达到模型单次输出上限。请紧接着中断处继续输出剩余内容，不要重复已经输出的部分，也不要用总结代替剩余内容。';
          request.onTextDelta?.('\n\n');
          continue;
        }
      }
      if (carried) answer = answer.trim() && !answer.startsWith(carried) ? carried + '\n\n' + answer : carried;
      if (usageState.budgetError) {
        const notice = '本轮已因预算限制停止，任务尚未完成；已保留现有输出。' + usageState.budgetError.message;
        answer = (answer.trim() ? answer.trimEnd() + '\n\n' : '') + notice;
        request.onTextDelta?.((content.trim() ? '\n\n' : '') + notice);
      } else if (toolLimitReached && (!summaryCompleted || summaryFailed || last?.stopReason === 'error')) {
        answer = '工具额度已用尽（' + limitDescription + '）。阶段总结未能生成，本轮分析尚未完成。\n\n'
          + (completedTools.length ? '已完成 ' + completedTools.length + ' 次工具操作，最近的操作包括：\n' + completedTools.slice(-12).map((label) => '- ' + label).join('\n') : '本轮没有获得可用的工具结果。')
          + '\n\n继续任务时可从上述已检查范围接着分析。';
        request.onTextDelta?.((content.trim() ? '\n\n' : '') + answer);
      }
      if (!answer.trim()) throw new Error('模型返回空文本，未生成可用回答');
      let result: AgentRunResult = {
        content: answer,
        inputTokens: Math.max(usageState.usage.inputTokens, stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite),
        outputTokens: Math.max(usageState.usage.outputTokens, stats.tokens.output),
        toolCalls,
        stopReason: usageState.budgetError ? 'budget_limit' : toolLimitReached ? 'tool_limit' : effectiveStopReason ?? 'stop',
        ...(usageState.budgetError ? { budgetLimitReason: usageState.budgetError.message } : {}),
      };
      let continuation;
      try {
        continuation = request.afterTurn ? await awaitWithSignal(Promise.resolve(request.afterTurn(result, { signal: request.signal })), request.signal) : undefined;
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        usageState.budgetError = error;
        const notice = '本轮已因预算限制停止，任务尚未完成；已保留现有输出。' + error.message;
        request.onTextDelta?.('\n\n' + notice);
        return { ...result, content: result.content.trimEnd() + '\n\n' + notice, stopReason: 'budget_limit', budgetLimitReason: error.message };
      }
      if (!continuation) return result;
      if (continuation.stopReason) result = { ...result, stopReason: continuation.stopReason, ...(continuation.stopReason === 'budget_limit' ? { budgetLimitReason: result.budgetLimitReason ?? continuation.summary ?? '项目验证达到运行预算' } : {}) };
      if (continuation.feedback?.trim() && !['tool_limit', 'budget_limit', 'length'].includes(result.stopReason)) {
        previousAnswer = result.content;
        content = '';
        prompt = continuation.feedback;
        continue;
      }
      if (continuation.summary?.trim() && !result.content.includes(continuation.summary.trim())) {
        const suffix = '\n\n' + continuation.summary.trim();
        result = { ...result, content: result.content.trimEnd() + suffix };
        request.onTextDelta?.(suffix);
      }
      return result;
    }
  } finally {
    request.signal?.removeEventListener('abort', onAbort);
    unsubscribe();
    session.dispose();
  }
}
