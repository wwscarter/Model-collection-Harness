import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { createProvider as createConfiguredProvider, parseSSE, type ModelStreamChunk } from '../../src/core/providers/ModelProvider';
import { testModelConnection } from '../../src/core/providers/ModelConnection';

const model = (provider: ModelConfig['provider'] = 'custom', overrides: Partial<ModelConfig> = {}): ModelConfig => ({
  id: 'synthetic-model', name: 'Synthetic model', provider, apiKey: 'synthetic-credential', baseURL: 'https://provider.example/v1', modelId: 'synthetic',
  enabled: true, priority: 0, capabilities: [], maxTokens: 64, rateLimit: { requestsPerMinute: 60, tokensPerDay: 10000 },
  costPer1kTokens: { input: 0, output: 0 }, createdAt: new Date(), updatedAt: new Date(), ...overrides,
});
const providers = ['custom', 'anthropic', 'google'] as const;
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const sse = (events: unknown[]) => new Response(events.map((event) => 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event)) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
const collect = async (stream: AsyncIterable<ModelStreamChunk>) => { const chunks: ModelStreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
afterEach(() => vi.unstubAllGlobals());

const createProvider = (config: ModelConfig) => createConfiguredProvider(config, { legacyProviders: true });

describe('legacy provider compatibility responses', () => {
  it.each(providers)('does not accept an empty successful %s response', async (provider) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ choices: [], content: [], candidates: [] })));
    await expect(createProvider(model(provider)).invoke('hello')).rejects.toThrow('empty text response');
  });

  it.each(providers)('reports an error returned in an HTTP 200 %s response', async (provider) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'Service temporarily unavailable' } })));
    await expect(createProvider(model(provider)).invoke('hello')).rejects.toThrow('Service temporarily unavailable');
  });

  it('does not report a blank gateway response as a successful connection test', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})));
    const result = await testModelConnection({ provider: 'custom', baseURL: 'https://provider.example/v1', modelId: 'synthetic' }, { getModel: () => undefined }, { legacyProviders: true });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('empty text response') });
  });

  it('accepts text content parts and estimates usage when a gateway returns invalid counters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ choices: [{ message: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] } }], usage: { prompt_tokens: -1, completion_tokens: 'unavailable' } })));
    expect(await createProvider(model()).invoke('hello')).toMatchObject({ content: 'hello world', inputTokens: 2, outputTokens: 3 });
  });

  it.each(providers)('respects the saved maximum output tokens for %s utility calls', async (provider) => {
    const fetchMock = vi.fn(async () => json({ choices: [{ message: { content: 'hello' } }], content: [{ text: 'hello' }], candidates: [{ content: { parts: [{ text: 'hello' }] } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await createProvider(model(provider)).invoke('hello', { maxTokens: 500 });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(provider === 'google' ? body.generationConfig.maxOutputTokens : body.max_tokens).toBe(64);
  });

  it('requires a usable credential instead of implicitly creating a mock provider', () => {
    expect(() => createProvider(model('openai', { apiKey: '' }))).toThrow('API Key');
    expect(() => createProvider(model('custom', { apiKey: '', credentialError: 'Credential store unavailable' }))).toThrow('API Key');
  });

  it.each(providers)('reports %s stream error events', async (provider) => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ error: { message: 'Service temporarily unavailable' } }])));
    await expect(collect(createProvider(model(provider)).invokeStream!('hello'))).rejects.toThrow('Service temporarily unavailable');
  });

  it.each(providers)('does not mark a prematurely closed %s stream as completed', async (provider) => {
    const content = { choices: [{ delta: { content: 'partial' } }], delta: { text: 'partial' }, candidates: [{ content: { parts: [{ text: 'partial' }] } }] };
    vi.stubGlobal('fetch', vi.fn(async () => sse([content])));
    await expect(collect(createProvider(model(provider)).invokeStream!('hello'))).rejects.toThrow('terminated before completion');
  });

  it.each(providers)('finishes a valid %s stream with its final usage', async (provider) => {
    const events = provider === 'custom' ? [
      { choices: [{ delta: { content: 'hello' } }] }, { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }, '[DONE]',
    ] : provider === 'anthropic' ? [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } }, { type: 'content_block_delta', delta: { text: 'hello' } },
      { type: 'message_delta', usage: { output_tokens: 2 } }, { type: 'message_stop' },
    ] : [{ candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }];
    vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
    const chunks = await collect(createProvider(model(provider)).invokeStream!('hello'));
    expect(chunks.map((chunk) => chunk.delta).join('')).toBe('hello');
    expect(chunks.at(-1)).toMatchObject({ done: true, inputTokens: 10, outputTokens: 2 });
  });

  it('cancels an unfinished response when the stream consumer stops early', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: hello\n\n')); }, cancel });
    for await (const _event of parseSSE(new Response(stream))) break;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
