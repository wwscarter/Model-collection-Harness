import type { ModelConfig } from '@core/models/ModelConfig';
import { estimateTextTokens } from './ContextAssembler';

export interface ModelContextBudget { contextWindow: number; maxOutputTokens: number; reserveTokens: number; maxInputTokens: number; }

/** A common budget allows an already prepared request to use any fallback. */
export function modelContextBudget(models: Pick<ModelConfig, 'contextWindow' | 'maxTokens'>[], outputLimit = 4_000): ModelContextBudget {
  const contextWindow = Math.max(1, Math.min(...models.map((model) => model.contextWindow ?? model.maxTokens)));
  const maxOutputTokens = Math.max(1, Math.min(outputLimit, Math.floor(contextWindow / 2) || 1, ...models.map((model) => model.maxTokens)));
  const reserveTokens = Math.min(8_000, Math.floor(contextWindow / 4), Math.max(0, contextWindow - maxOutputTokens));
  return { contextWindow, maxOutputTokens, reserveTokens, maxInputTokens: Math.max(0, contextWindow - maxOutputTokens - reserveTokens) };
}

export function assertPromptFits(prompt: string, budget: ModelContextBudget): void {
  if (estimateTextTokens(prompt) > budget.maxInputTokens) throw new Error(`任务描述或执行指令超过所选模型的输入预算（${budget.maxInputTokens} Token），请缩短任务或选择更大上下文的模型`);
}

/** The builder captures the user request; only its supplementary parts may shrink. */
export function fitPromptParts(build: (parts: string[]) => string, parts: string[], maxTokens: number): string {
  const fitted = [...parts];
  const notice = '\n\n[附加上下文已按模型窗口截断]';
  let prompt = build(fitted);
  let trimmed = false;
  for (let index = 0; estimateTextTokens(prompt) > maxTokens && index < fitted.length; index += 1) {
    if (!fitted[index]) continue;
    const overflowChars = (estimateTextTokens(prompt) - maxTokens) * 4 + notice.length + 8;
    fitted[index] = fitted[index].slice(0, Math.max(0, fitted[index].length - overflowChars));
    trimmed = true;
    prompt = build(fitted) + notice;
  }
  if (estimateTextTokens(prompt) > maxTokens) {
    const protectedPrompt = build(parts.map(() => ''));
    if (estimateTextTokens(protectedPrompt) <= maxTokens) return protectedPrompt;
    throw new Error(`任务描述或执行指令超过所选模型的输入预算（${maxTokens} Token），请缩短任务或选择更大上下文的模型`);
  }
  return trimmed ? prompt : build(fitted);
}
