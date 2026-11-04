import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { ModelRegistry } from '../../src/core/models/ModelRegistry';
import { fetchModelIdentifiers, testModelConnection } from '../../src/core/providers/ModelConnection';
import { createProvider } from '../../src/core/providers/ModelProvider';

const model = (overrides: Partial<ModelConfig> = {}): ModelConfig => ({
  id: 'saved-model', provider: 'custom', name: 'Saved model', apiKey: 'saved-secret',
  baseURL: 'https://saved.example/v1', modelId: 'saved-model-id', temperature: 0.4, enableThinking: false,
  maxTokens: 4096, contextWindow: 65_536, costPer1kTokens: { input: 0, output: 0 }, capabilities: [],
  rateLimit: { requestsPerMinute: 60, tokensPerDay: 1_000_000 }, enabled: true, priority: 0,
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...overrides,
});
const registryWith = (config: ModelConfig = model()) => {
  const registry = new ModelRegistry(undefined, { initializePresets: false, persist: false });
  registry.registerModel(config);
  return registry;
};
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('draft model discovery', () => {
  it('uses the draft URL and saved credential without changing the saved configuration or exposing the key', async () => {
    const registry = registryWith();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: '' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchModelIdentifiers({ id: 'saved-model', provider: 'custom', baseURL: 'https://saved.example/v1/chat/completions?tenant=alpha', apiKey: '' }, registry);
    expect(fetchMock).toHaveBeenCalledWith('https://saved.example/v1/models?tenant=alpha', expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ authorization: 'Bearer saved-secret' }) }));
    expect(result).toEqual({ models: ['a', 'b'] });
    expect(registry.getModel('saved-model')).toMatchObject({ baseURL: 'https://saved.example/v1', apiKey: 'saved-secret', modelId: 'saved-model-id' });
  });

  it('does not send a saved credential to a different origin', async () => {
    const registry = registryWith();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ data: [{ id: 'next' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchModelIdentifiers({ id: 'saved-model', provider: 'custom', baseURL: 'https://draft.example/v1' }, registry);
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty('authorization');
  });

  it('uses a replacement draft credential and permits credential-free local endpoints', async () => {
    const registry = registryWith();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ data: [{ id: 'local-coder' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchModelIdentifiers({ id: 'saved-model', provider: 'custom', apiKey: 'draft-secret' }, registry);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ authorization: 'Bearer draft-secret' });
    await fetchModelIdentifiers({ provider: 'custom', baseURL: 'http://127.0.0.1:11434/v1' }, registry);
    expect(fetchMock.mock.calls[1][1]?.headers).not.toHaveProperty('authorization');
  });

  it('reads Anthropic paginated model catalogues with its native auth headers', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' }))
      .mockResolvedValueOnce(json({ data: [{ id: 'claude-b' }], has_more: false }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchModelIdentifiers({ provider: 'anthropic', baseURL: 'https://anthropic.example/v1/messages', apiKey: 'native-secret' }, registryWith());
    expect(fetchMock.mock.calls[0]).toEqual(['https://anthropic.example/v1/models', expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'native-secret', 'anthropic-version': '2023-06-01' }) })]);
    expect(fetchMock.mock.calls[1][0]).toBe('https://anthropic.example/v1/models?after_id=claude-a');
    expect(result.models).toEqual(['claude-a', 'claude-b']);
  });

  it('paginates Google model catalogues and excludes non-generative models', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({ models: [{ name: 'models/gemini-chat', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed-only', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next' }))
      .mockResolvedValueOnce(json({ models: [{ name: 'models/gemini-code', supportedGenerationMethods: ['generateContent'] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchModelIdentifiers({ provider: 'google', apiKey: 'google-secret', baseURL: 'https://google.example/v1beta/models/old:generateContent' }, registryWith());
    expect(fetchMock.mock.calls[0][0]).toBe('https://google.example/v1beta/models?key=google-secret');
    expect(fetchMock.mock.calls[1][0]).toBe('https://google.example/v1beta/models?key=google-secret&pageToken=next');
    expect(result.models).toEqual(['gemini-chat', 'gemini-code']);
  });

  it('reports upstream errors and incompatible responses instead of inventing models', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(json({ unrelated: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const input = { provider: 'custom', baseURL: 'https://custom.example/v1' };
    await expect(fetchModelIdentifiers(input, registryWith())).rejects.toThrow('HTTP 401');
    await expect(fetchModelIdentifiers(input, registryWith())).rejects.toThrow('端点未返回兼容的模型列表');
  });

  it('rejects missing built-in credentials and unknown saved IDs without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchModelIdentifiers({ provider: 'openai' }, registryWith())).rejects.toThrow('API Key');
    await expect(fetchModelIdentifiers({ id: 'missing', provider: 'custom' }, registryWith())).rejects.toThrow('已不存在');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects cross-provider saved identifiers instead of sending another provider saved credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchModelIdentifiers({ id: 'saved-model', provider: 'anthropic' }, registryWith())).rejects.toThrow('不可复用其他供应商的凭据');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('draft connection test', () => {
  it('tests unsaved URL, model and inference fields using the saved credential', async () => {
    const registry = registryWith(model({ provider: 'deepseek' }));
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ choices: [{ message: { content: 'connected' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await testModelConnection({ id: 'saved-model', provider: 'deepseek', baseURL: 'https://saved.example/v1', modelId: 'draft-model-id', temperature: 0.9, enableThinking: true }, registry);
    expect(result).toMatchObject({ success: true, demo: false });
    expect(fetchMock.mock.calls[0][0]).toBe('https://saved.example/v1/chat/completions');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ authorization: 'Bearer saved-secret' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model: 'draft-model-id', temperature: 0.9, thinking: { type: 'enabled' } });
    expect(registry.getModel('saved-model')).toMatchObject({ modelId: 'saved-model-id', temperature: 0.4, enableThinking: false });
  });

  it('requires a new key when the draft endpoint changes origin', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await testModelConnection({ id: 'saved-model', provider: 'deepseek', baseURL: 'https://draft.example/v1', modelId: 'draft-model-id' }, registryWith(model({ provider: 'deepseek' })));
    expect(result).toMatchObject({ success: false, demo: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not pass a demo provider off as a live connection', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await testModelConnection({ provider: 'openai', modelId: 'demo' }, registryWith());
    expect(result).toMatchObject({ success: false, demo: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns failed remote connections and invalid draft values as visible errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    const registry = registryWith();
    expect(await testModelConnection({ id: 'saved-model', provider: 'custom' }, registry)).toMatchObject({ success: false, error: expect.stringContaining('503') });
    expect(await testModelConnection({ provider: 'custom', baseURL: 'file:///tmp/models', modelId: 'invalid' }, registry)).toMatchObject({ success: false, error: expect.stringContaining('http') });
    expect(await testModelConnection({ provider: 'custom', baseURL: 'https://user:pass@example.com/v1', modelId: 'invalid' }, registry)).toMatchObject({ success: false, error: expect.stringContaining('用户名') });
    expect(await testModelConnection({ id: 'saved-model', provider: 'custom', temperature: 2 }, registry)).toMatchObject({ success: false, error: expect.stringContaining('0–1.5') });
  });

  it('rejects unsupported Anthropic temperatures and cross-provider credential fallback before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await testModelConnection({ provider: 'anthropic', apiKey: 'key', modelId: 'claude-model', temperature: 1.1 }, registryWith())).toMatchObject({ success: false, error: expect.stringContaining('0–1') });
    expect(await testModelConnection({ id: 'saved-model', provider: 'anthropic', modelId: 'claude-model' }, registryWith())).toMatchObject({ success: false, error: expect.stringContaining('不可复用其他供应商的凭据') });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('persisted inference preferences', () => {
  it('uses persisted temperatures and lets an invocation explicitly override them', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ choices: [{ message: { content: 'hello' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createProvider(model({ temperature: 1.2, enableThinking: true }));
    await provider.invoke('hello');
    await provider.invoke('hello', { temperature: 0 });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ temperature: 1.2 });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).not.toHaveProperty('thinking');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ temperature: 0 });
  });

  it('passes the DeepSeek thinking toggle and temperature to streamed and regular calls', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => JSON.parse(String(init?.body)).stream
      ? new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      : json({ choices: [{ message: { content: 'hello' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createProvider(model({ provider: 'deepseek', baseURL: undefined, enableThinking: false, temperature: 0.3 }));
    await provider.invoke('hello');
    for await (const _chunk of provider.invokeStream!('hello')) { /* consume the real SSE parser */ }
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1/chat/completions']);
    for (const [, init] of fetchMock.mock.calls) expect(JSON.parse(String(init?.body))).toMatchObject({ temperature: 0.3, thinking: { type: 'disabled' } });
  });

  it('applies saved temperature for native Anthropic and Google adapters with base URL normalization', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ content: [{ text: 'hello' }], candidates: [{ content: { parts: [{ text: 'hello' }] } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await createProvider(model({ provider: 'anthropic', baseURL: 'https://anthropic.example/v1', temperature: 0.2 })).invoke('hello');
    await createProvider(model({ provider: 'google', baseURL: 'https://google.example/v1beta?tenant=demo', modelId: 'new-gemini', temperature: 0.8 })).invoke('hello');
    expect(fetchMock.mock.calls[0][0]).toBe('https://anthropic.example/v1/messages');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ temperature: 0.2 });
    expect(fetchMock.mock.calls[1][0]).toBe('https://google.example/v1beta/models/new-gemini:generateContent?tenant=demo&key=saved-secret');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ generationConfig: { temperature: 0.8 } });
  });
});
