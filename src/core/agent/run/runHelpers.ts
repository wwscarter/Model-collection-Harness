import type { ContextToolDigest, ContextTurn } from '@core/context/ContextAssembler';
import type { ModelConfig } from '@core/models/ModelConfig';
import type { ModelUsage } from '@core/routing/ModelUsage';

export function estimateTokens(value: string): number { return Math.max(1, Math.ceil(value.length / 4)); }

export const TOOL_LIMIT_NOTICE = '已达到本轮工具执行额度，任务尚未完成；已保留当前阶段总结，可继续处理剩余工作。';

export const PARTIAL_AGENT_NOTICE = '【子任务部分完成：已达到工具执行额度】以下报告仅为当前阶段总结，未完成项仍需继续处理，不可视为完整成果。';

export const OUTPUT_LIMIT_NOTICE = '本轮输出达到模型长度上限，回答可能不完整；可继续处理剩余内容。';

export const limitedStop = (stopReason?: string): boolean => ['tool_limit', 'budget_limit', 'length'].includes(stopReason ?? '');

export const limitMessage = (stopReason?: string): string | undefined => stopReason === 'budget_limit' ? '本轮已达到预估费用预算，已保留阶段结果；可在设置中调整运行预算。' : stopReason === 'length' ? OUTPUT_LIMIT_NOTICE : stopReason === 'tool_limit' ? TOOL_LIMIT_NOTICE : undefined;

export function costOf(inputTokens: number, outputTokens: number, model: Pick<ModelConfig, 'costPer1kTokens'>): number {
  return (inputTokens * model.costPer1kTokens.input + outputTokens * model.costPer1kTokens.output) / 1000;
}

export function errorUsage(error: unknown): ModelUsage {
  const usage = error && typeof error === 'object' ? (error as { modelUsage?: ModelUsage }).modelUsage : undefined;
  return { inputTokens: Number.isFinite(usage?.inputTokens) ? Math.max(0, usage!.inputTokens) : 0, outputTokens: Number.isFinite(usage?.outputTokens) ? Math.max(0, usage!.outputTokens) : 0 };
}

export function publicModel(model: ModelConfig) {
  const { apiKey, ...safe } = model;
  return { ...safe, hasApiKey: Boolean(apiKey) };
}

export function sanitizeHistory(value: unknown): ContextTurn[] {
  if (!Array.isArray(value)) return [];
  // Summary coverage and its hash are relative to the conversation's beginning.
  // Keep that stable prefix here; ContextAssembler bounds the model-facing history.
  return value.flatMap((turn): ContextTurn[] => {
    const candidate = turn as Partial<ContextTurn> | null;
    if (!candidate || (candidate.role !== 'user' && candidate.role !== 'assistant') || typeof candidate.content !== 'string') return [];
    const tools: ContextToolDigest[] = Array.isArray(candidate.tools)
      ? candidate.tools.slice(0, 30).flatMap((tool): ContextToolDigest[] => {
        if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !tool.name) return [];
        return [{
          name: tool.name.slice(0, 100),
          status: typeof tool.status === 'string' ? tool.status.slice(0, 20) : undefined,
          label: typeof tool.label === 'string' ? tool.label.slice(0, 300) : undefined,
          summary: typeof tool.summary === 'string' ? tool.summary.slice(0, 600) : undefined,
        }];
      })
      : [];
    return [{ role: candidate.role, content: candidate.content.slice(0, 40_000), ...(tools.length ? { tools } : {}) }];
  });
}

export function routingPriorContext(value: unknown, summary?: string): string | undefined {
  const snippet = (content: string, limit: number): string => {
    const clean = content.trim();
    if (clean.length <= limit) return clean;
    const marker = '…[截断]…';
    const head = Math.floor((limit - marker.length) / 2);
    return clean.slice(0, head) + marker + clean.slice(-(limit - marker.length - head));
  };
  const recent: string[] = [];
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0 && recent.length < 2; index -= 1) {
      const turn = value[index] as Partial<ContextTurn> | null;
      if (!turn || (turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.content !== 'string' || !turn.content.trim()) continue;
      // Read the original turn so sanitizing long execution history cannot discard its closing options.
      recent.unshift(`${turn.role}: ${snippet(turn.content, 100)}`);
    }
  }
  if (recent.length) return recent.join('\n');
  return summary?.trim() ? `summary: ${snippet(summary, 240)}` : undefined;
}
