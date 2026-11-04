import { describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { summarizeContext } from '../../src/core/context/SummaryService';

const model: ModelConfig = {
  id: 'summary-model', provider: 'deepseek', name: 'Summary', apiKey: 'test', modelId: 'm',
  costPer1kTokens: { input: 0.01, output: 0.02 }, capabilities: [], maxTokens: 4096,
  rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 }, enabled: true, priority: 0,
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
};

describe('SummaryService', () => {
  it('builds a checkpoint prompt with previous summary and tool facts', async () => {
    const invoke = vi.fn(async (prompt: string) => ({ content: 'Goals: finish the migration.\nFiles: src/a.ts', inputTokens: 100, outputTokens: 20, modelId: 'm' }));
    const result = await summarizeContext({
      previous: 'Previous: chose pnpm',
      turns: [
        { role: 'user', content: 'please fix src/a.ts' },
        { role: 'assistant', content: 'I read it', tools: [{ name: 'read', status: 'completed', label: 'src/a.ts' }] },
      ],
      model,
      provider: { invoke },
    });
    expect(result).toMatchObject({ text: 'Goals: finish the migration.\nFiles: src/a.ts', inputTokens: 100, outputTokens: 20, cost: 0.0014 });
    expect(invoke.mock.calls[0][0]).toContain('Previous: chose pnpm');
    expect(invoke.mock.calls[0][0]).toContain('read');
    expect(invoke.mock.calls[0][0]).toContain('src/a.ts');
  });

  it('returns undefined when there is nothing to summarize', async () => {
    const invoke = vi.fn();
    await expect(summarizeContext({ turns: [], model, provider: { invoke } })).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
