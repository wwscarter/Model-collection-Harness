import { describe, expect, it } from 'vitest';
import { assertPromptFits, fitPromptParts, modelContextBudget } from '../../src/core/context/ContextBudget';

describe('model context budget', () => {
  it('reserves output and system space for the smallest execution candidate', () => {
    expect(modelContextBudget([{ contextWindow: 64_000, maxTokens: 4096 }, { contextWindow: 16_000, maxTokens: 4096 }])).toEqual({ contextWindow: 16_000, maxOutputTokens: 4_000, reserveTokens: 4_000, maxInputTokens: 8_000 });
  });

  it('adapts output and overhead reservations to small windows', () => {
    const budget = modelContextBudget([{ contextWindow: 4_096, maxTokens: 4096 }]);
    expect(budget.maxOutputTokens + budget.reserveTokens + budget.maxInputTokens).toBe(4096);
    expect(budget.maxInputTokens).toBe(1024);
    expect(() => assertPromptFits('hello', budget)).not.toThrow();
  });

  it('preserves user requirements while truncating additional context with a notice', () => {
    const user = 'Preserve USER_REQUIREMENT_AT_END';
    const prompt = fitPromptParts((parts) => `${user}\n<context>${parts[0]}</context>`, ['project contents '.repeat(5_000)], 512);
    expect(prompt).toContain(user);
    expect(prompt).toContain('</context>');
    expect(prompt).toContain('附加上下文已按模型窗口截断');
    expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(512);
  });

  it('reports an oversized protected request instead of truncating it', () => {
    expect(() => fitPromptParts(() => 'user requirement '.repeat(500), [], 512)).toThrow('输入预算');
  });

  it('does not reject an exactly fitting request because its truncation notice cannot fit', () => {
    const user = 'x'.repeat(2_048);
    expect(fitPromptParts((parts) => user + parts[0], ['additional project context'], 512)).toBe(user);
  });
});
