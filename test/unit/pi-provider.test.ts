import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { createProvider, type ModelStreamChunk } from '../../src/core/providers/ModelProvider';
import { PiProvider } from '../../src/core/providers/PiProvider';
import { testModelConnection } from '../../src/core/providers/ModelConnection';

const servers: http.Server[] = [];
type Provider = 'custom' | 'deepseek' | 'anthropic' | 'google';
const model = (provider: Provider, baseURL: string, overrides: Partial<ModelConfig> = {}): ModelConfig => ({
  id: 'synthetic-' + provider, name: 'Synthetic ' + provider, provider, baseURL, apiKey: 'synthetic-key',
  modelId: 'synthetic-model', maxTokens: 64, contextWindow: 65_536, temperature: 0.3,
  costPer1kTokens: { input: 0.001, output: 0.002 }, capabilities: [],
  rateLimit: { requestsPerMinute: 0, tokensPerDay: 0 }, priority: 0, enabled: true,
  createdAt: new Date(), updatedAt: new Date(), ...overrides,
});
const collect = async (stream: AsyncIterable<ModelStreamChunk>) => { const chunks: ModelStreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

async function endpoint(handler: (request: http.IncomingMessage, response: http.ServerResponse, body: Record<string, any>) => void) {
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = http.createServer(async (request, response) => {
    let input = '';
    for await (const part of request) input += part;
    const body = JSON.parse(input || '{}');
    requests.push({ url: request.url!, headers: request.headers, body });
    handler(request, response, body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server port');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}
function event(response: http.ServerResponse, data: unknown, name?: string) {
  response.write((name ? `event: ${name}\n` : '') + 'data: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n');
}
function reply(response: http.ServerResponse, provider: Provider, text = 'hello world', usage = true) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (provider === 'anthropic') {
    event(response, { type: 'message_start', message: { id: 'synthetic', type: 'message', role: 'assistant', content: [], model: 'synthetic-model', usage: { input_tokens: usage ? 10 : 0, output_tokens: 0, cache_read_input_tokens: usage ? 3 : 0, cache_creation_input_tokens: usage ? 2 : 0 } } }, 'message_start');
    if (text) {
      event(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
      event(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, 'content_block_delta');
      event(response, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
    }
    event(response, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage ? 2 : 0 } }, 'message_delta');
    event(response, { type: 'message_stop' }, 'message_stop');
  } else if (provider === 'google') {
    event(response, { candidates: [{ index: 0, content: { role: 'model', parts: text ? [{ text }] : [] }, finishReason: 'STOP' }], ...(usage ? { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } } : {}) });
  } else {
    if (provider === 'deepseek') event(response, { choices: [{ index: 0, delta: { reasoning_content: 'synthetic internal thought' } }] });
    if (text) event(response, { choices: [{ index: 0, delta: { content: text } }] });
    event(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(usage ? { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } : {}) });
    event(response, '[DONE]');
  }
  response.end();
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

describe('unified Pi provider', () => {
  it.each<Provider>(['custom', 'deepseek', 'anthropic', 'google'])('invokes %s through Pi with final usage and bounded output', async (provider) => {
    const service = await endpoint((_request, response) => reply(response, provider));
    const config = model(provider, service.url + (provider === 'google' ? '/v1beta' : '/v1'));
    const adapter = createProvider(config);
    expect(adapter).toBeInstanceOf(PiProvider);
    expect(await adapter.invoke('hello', { maxTokens: 500 })).toMatchObject({ content: 'hello world', inputTokens: provider === 'anthropic' ? 15 : 10, outputTokens: 2, modelId: config.id, stopReason: 'stop' });
    expect(service.requests).toHaveLength(1);
    const request = service.requests[0];
    expect(provider === 'google' ? request.body.generationConfig.maxOutputTokens : request.body.max_tokens).toBe(64);
    expect(provider === 'google' ? request.body.generationConfig.temperature : request.body.temperature).toBe(0.3);
    expect(request.url).toContain(provider === 'google' ? '/v1beta/models/synthetic-model:streamGenerateContent' : provider === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
    if (provider === 'anthropic') {
      expect(request.headers['x-api-key']).toBe('synthetic-key');
      expect(request.headers['anthropic-version']).toBe('2023-06-01');
    }
  });

  it.each<Provider>(['custom', 'deepseek', 'anthropic', 'google'])('streams only answer text and final usage for %s', async (provider) => {
    const service = await endpoint((_request, response) => reply(response, provider));
    const chunks = await collect(createProvider(model(provider, service.url)).invokeStream!('hello'));
    expect(chunks.map((chunk) => chunk.delta).join('')).toBe('hello world');
    expect(chunks.at(-1)).toMatchObject({ done: true, inputTokens: provider === 'anthropic' ? 15 : 10, outputTokens: 2 });
  });

  it.each<Provider>(['custom', 'anthropic', 'google'])('rejects an empty %s answer', async (provider) => {
    const service = await endpoint((_request, response) => reply(response, provider, ''));
    await expect(createProvider(model(provider, service.url)).invoke('hello')).rejects.toThrow('empty text response');
  });

  it.each<Provider>(['custom', 'anthropic', 'google'])('reports HTTP errors without retries for %s', async (provider) => {
    const service = await endpoint((_request, response) => { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Synthetic service unavailable', status: 'UNAVAILABLE', code: 503 } })); });
    await expect(createProvider(model(provider, service.url)).invoke('hello')).rejects.toThrow(/503|Synthetic service unavailable/);
    expect(service.requests).toHaveLength(1);
  });

  it('estimates missing usage, preserves explicit temperature and sends no placeholder auth for a keyless gateway', async () => {
    const service = await endpoint((_request, response) => reply(response, 'custom', 'hello world', false));
    expect(await createProvider(model('custom', service.url + '/v1/chat/completions', { apiKey: '' })).invoke('hello', { temperature: 0 })).toMatchObject({ inputTokens: 2, outputTokens: 3 });
    expect(service.requests[0]).toMatchObject({ url: '/v1/chat/completions', body: { temperature: 0 } });
    expect(service.requests[0].headers.authorization).toBeUndefined();
  });

  it('passes both DeepSeek thinking preferences to Pi while omitting reasoning text from the answer', async () => {
    const service = await endpoint((_request, response) => reply(response, 'deepseek'));
    for (const enableThinking of [true, false]) await createProvider(model('deepseek', service.url, { enableThinking })).invoke('hello');
    expect(service.requests.map((request) => request.body.thinking)).toEqual([{ type: 'enabled' }, { type: 'disabled' }]);
  });

  it('preserves an application-budgeted output limit when older models omit the context window', async () => {
    const service = await endpoint((_request, response) => reply(response, 'custom'));
    const adapter = createProvider(model('custom', service.url, { contextWindow: undefined, maxTokens: 4096 }));
    await adapter.invoke('hello', { maxTokens: 1000 });
    expect(service.requests[0].body.max_tokens).toBe(1000);
    await expect(adapter.invoke('x'.repeat(20_000), { maxTokens: 1000 })).rejects.toThrow('输入预算');
    expect(service.requests).toHaveLength(1);
  });

  it.each<Provider>(['custom', 'anthropic'])('normalizes full %s endpoints while preserving gateway query parameters', async (provider) => {
    const service = await endpoint((_request, response) => reply(response, provider));
    const full = provider === 'custom' ? '/v1/chat/completions' : provider === 'anthropic' ? '/v1/messages' : '/v1beta/models/old:generateContent';
    await createProvider(model(provider, service.url + full + '?tenant=synthetic')).invoke('hello');
    const requested = new URL(service.requests[0].url, service.url);
    expect(requested.pathname).toBe(provider === 'custom' ? '/v1/chat/completions' : provider === 'anthropic' ? '/v1/messages' : '/v1beta/models/synthetic-model:streamGenerateContent');
    expect(requested.searchParams.get('tenant')).toBe('synthetic');
  });

  it('reports the Google SDK query limitation and permits the explicit legacy fallback', async () => {
    const service = await endpoint((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }));
    });
    const config = model('google', service.url + '/v1beta?tenant=synthetic');
    expect(() => createProvider(config)).toThrow('旧版适配器');
    expect(await createProvider(config, { legacyProviders: true }).invoke('hello')).toMatchObject({ content: 'hello' });
    expect(service.requests[0].url).toContain('tenant=synthetic');
  });

  it('propagates cancellation during an in-flight completion', async () => {
    let started!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    const service = await endpoint((_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); started(); });
    const controller = new AbortController();
    const request = createProvider(model('custom', service.url)).invoke('hello', { signal: controller.signal });
    await reached; controller.abort(new Error('Synthetic cancellation'));
    await expect(request).rejects.toThrow('Synthetic cancellation');
  });

  it('cancels the HTTP response when a stream consumer stops early', async () => {
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => { closed = resolve; });
    const service = await endpoint((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      event(response, { choices: [{ index: 0, delta: { content: 'hello' } }] });
      response.on('close', closed);
    });
    for await (const _chunk of createProvider(model('custom', service.url)).invokeStream!('hello')) break;
    await disconnected;
  });

  it('rejects incomplete streams and explicit stream errors', async () => {
    let incomplete = true;
    const service = await endpoint((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      event(response, incomplete ? { choices: [{ index: 0, delta: { content: 'partial' } }] } : { error: { message: 'Synthetic stream error' } });
      response.end();
    });
    await expect(collect(createProvider(model('custom', service.url)).invokeStream!('hello'))).rejects.toThrow('finish_reason');
    incomplete = false;
    await expect(createProvider(model('custom', service.url)).invoke('hello')).rejects.toThrow('Synthetic stream error');
  });

  it('supports connection tests and an explicit legacy adapter fallback', async () => {
    const service = await endpoint((_request, response, body) => {
      if (body.stream) reply(response, 'custom');
      else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: 'legacy connected' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } })); }
    });
    const config = model('custom', service.url);
    expect(await testModelConnection({ provider: 'custom', baseURL: service.url, modelId: config.modelId }, { getModel: () => undefined })).toMatchObject({ success: true });
    const legacy = createProvider(config, { legacyProviders: true });
    expect(legacy).not.toBeInstanceOf(PiProvider);
    expect(await legacy.invoke('hello')).toMatchObject({ content: 'legacy connected', inputTokens: 5, outputTokens: 2 });
    expect(await testModelConnection({ provider: 'custom', baseURL: service.url, modelId: config.modelId }, { getModel: () => undefined }, { legacyProviders: true })).toMatchObject({ success: true });
  });
});
