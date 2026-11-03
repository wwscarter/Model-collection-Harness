import { describe, expect, it } from 'vitest';
import { MockProvider, parseSSE } from '../../src/core/providers/ModelProvider';

describe('streaming providers', () => {
  it('parses SSE events split across fetch chunks', async () => {
    const encoder = new TextEncoder();
    const chunks = ['data: {"delta":"hel', 'lo"}\n\n', 'event: message\ndata: [DONE]\n\n'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const values: string[] = [];
    for await (const value of parseSSE(new Response(stream))) values.push(value);
    expect(values).toEqual(['{"delta":"hello"}', '[DONE]']);
  });

  it('streams mock output in incremental chunks with final usage', async () => {
    const provider = new MockProvider({ id: 'mock', provider: 'openai', name: 'Mock', apiKey: '', modelId: 'mock', enabled: true, priority: 0, capabilities: [], maxTokens: 100, rateLimit: { requestsPerMinute: 60, tokensPerDay: 10000 }, costPer1kTokens: { input: 0, output: 0 }, createdAt: new Date(), updatedAt: new Date() });
    const chunks: Array<{ delta: string; done?: boolean; inputTokens?: number; outputTokens?: number }> = [];
    for await (const chunk of provider.invokeStream('test prompt')) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)).toMatchObject({ done: true, inputTokens: expect.any(Number), outputTokens: expect.any(Number) });
    expect(chunks.slice(0, -1).map((chunk) => chunk.delta).join('')).toContain('test prompt');
  });
});
