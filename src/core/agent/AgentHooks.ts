import { BudgetExceededError } from '@core/routing/RunBudget';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import type { AgentRunRequest } from './AgentRuntimeTypes';

const filesOf = (input: unknown): string[] => {
  const file = input && typeof input === 'object' ? (input as { path?: unknown }).path : undefined;
  return typeof file === 'string' && file ? [file] : [];
};

/** Declarative Hooks use the same app-owned runner throughout one coordinated run. */
export function prepareHooks(request: AgentRunRequest): { extension: InlineExtension; assertReady(): void } | undefined {
  const runner = request.hookRunner;
  if (!runner) return undefined;
  let error: unknown;
  return {
    assertReady() { if (error) throw error; },
    extension: { name: 'newai-hooks', hidden: true, factory: (pi) => {
      pi.on('tool_call', async (event) => {
        try {
          request.signal?.throwIfAborted();
          const result = await runner.run('pre_tool', { toolName: event.toolName, files: filesOf(event.input), signal: request.signal });
          return result.blocked ? { block: true, reason: result.blocked } : undefined;
        } catch (failure) {
          error = failure;
          return { block: true, terminate: true, reason: failure instanceof Error ? failure.message : 'Hook 已停止工具调用' };
        }
      });
      pi.on('tool_result', async (event) => {
        try {
          request.signal?.throwIfAborted();
          const result = await runner.run('post_tool', { toolName: event.toolName, files: filesOf(event.input), signal: request.signal });
          return result.report ? { content: [...event.content, { type: 'text' as const, text: '\n[项目 Hook 检查结果]\n' + result.report }], ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}) } : undefined;
        } catch (failure) {
          // Pi reports tool_result extension errors without propagating them.
          // Preserve a rejected budget gate for the next provider request.
          if (failure instanceof BudgetExceededError || request.signal?.aborted) error = failure;
          else return { content: [...event.content, { type: 'text' as const, text: '\nHook 检查未完成：' + (failure instanceof Error ? failure.message : String(failure)) }] };
        }
      });
    } },
  };
}
