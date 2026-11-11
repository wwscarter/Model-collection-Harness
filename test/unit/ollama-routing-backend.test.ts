import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalRoutingModel } from '@core/routing/LocalRoutingModel';
import { OllamaRoutingBackend } from '@core/routing/OllamaRoutingBackend';
import { DEFAULT_ROUTING_SETTINGS } from '@core/routing/RoutingSettings';
import { buildRoutingPrompt } from '@core/routing/RoutingPrompts';

const config = { ...DEFAULT_ROUTING_SETTINGS.classifier, mode: 'ollama' as const };
const task = { type: 'general' as const, description: '修复这个 TypeScript bug', priorContext: '此前正在调整一个局部函数。' };
const answer = { taskType: 'code', complexity: 'medium', confidence: 0 };
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
function fixture(chat?: (init?: RequestInit) => Promise<Response>, models: unknown[] = [{ name: config.model, digest: 'local-model-digest' }], loaded = true) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === '/api/version') return response({ version: 'test-version' });
    if (pathname === '/api/tags') return response({ models });
    if (pathname === '/api/ps') return response({ models: loaded ? [{ name: config.model }] : [] });
    if (pathname === '/api/chat') return chat ? chat(init) : response({ done: true, message: { content: JSON.stringify(answer) } });
    throw new Error('unexpected endpoint ' + pathname);
  });
}
function blocked() {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let signal: AbortSignal | undefined;
  const chat = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = init?.signal ?? undefined;
    entered();
    signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
  });
  return { started, chat, get signal() { return signal; } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Ollama routing backend', () => {
  it('does not claim availability before checking service and model, and sends the constrained v3 request', async () => {
    const fetcher = fixture();
    const backend = new OllamaRoutingBackend(config, { fetch: fetcher });
    expect(backend.getStatus()).toMatchObject({ backend: 'ollama', configured: true, available: false });
    expect(backend.getStatus().reachable).toBeUndefined();
    expect(await backend.probe()).toMatchObject({ available: true, reachable: true, modelInstalled: true, loaded: true });
    const prediction = await backend.classify(task);
    expect(prediction).toMatchObject({ ...answer, backend: 'ollama', model: config.model, backendVersion: 'test-version', modelDigest: 'local-model-digest', promptVersion: 'v3' });
    expect(prediction.durationMs).toBeGreaterThanOrEqual(0);
    const call = fetcher.mock.calls.find(([url]) => String(url).endsWith('/api/chat'))!;
    expect(call[1]?.redirect).toBe('error');
    const body = JSON.parse(String(call[1]?.body));
    expect(body).toMatchObject({ model: config.model, stream: false, think: false, keep_alive: '5m', options: { temperature: 0, num_ctx: 2048, num_predict: 80, num_thread: 4 }, format: { additionalProperties: false } });
    expect(body.options).not.toHaveProperty('num_gpu');
    expect(body.messages[0].content).toBe(buildRoutingPrompt(task));
    expect(backend.getStatus()).toMatchObject({ loaded: true, lastError: undefined });
  });

  it('returns offline diagnostics and falls back to the existing rules without changing labels', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection refused'));
    const backend = new OllamaRoutingBackend(config, { fetch: fetcher });
    expect(await backend.probe()).toMatchObject({ available: false, reachable: false, lastError: expect.stringContaining('connection refused') });
    const local = new LocalRoutingModel({ classifier: backend });
    expect(await local.classify(task)).toMatchObject({ taskType: 'code', backend: 'heuristic', model: config.model, promptVersion: 'v3', fallbackReason: expect.stringContaining('unreachable') });
  });

  it('defers a cold model to background preparation without attempting foreground inference or opening the circuit', async () => {
    const fetcher = fixture(undefined, [{ name: config.model }], false);
    const backend = new OllamaRoutingBackend(config, { fetch: fetcher });
    for (let i = 0; i < 4; i += 1) await expect(backend.classify(task)).rejects.toMatchObject({ code: 'cold' });
    expect(backend.getStatus()).toMatchObject({ available: true, reachable: true, modelInstalled: true, loaded: false, circuitOpenUntil: undefined });
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/api/chat'))).toBe(false);
    expect(await new LocalRoutingModel({ classifier: backend }).classify(task)).toMatchObject({ backend: 'heuristic', fallbackReason: expect.stringContaining('preparing model') });
  });

  it('reports bounded feedback metadata without asking the model to emit metadata fields', async () => {
    const fetcher = fixture();
    const backend = new OllamaRoutingBackend(config, { fetch: fetcher });
    const prediction = await backend.classify({ ...task, description: 'A'.repeat(1001), confirmedExamples: [{ description: 'A user-confirmed local review', taskType: 'review', complexity: 'medium' }] });
    expect(prediction).toMatchObject({ inputTruncated: true, exampleCount: 1, promptVersion: 'v3+feedback' });
    const body = JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).endsWith('/api/chat'))![1]?.body));
    expect(body.format.required).toEqual(['taskType', 'complexity', 'confidence']);
    expect(body.messages[0].content).toContain('A user-confirmed local review');
  });

  it('reports a missing installed model and filters cloud aliases without pulling anything', async () => {
    const fetcher = fixture(undefined, [{ name: 'other:1b' }, { name: 'foo:cloud' }, { name: 'remote:1b', remote_host: 'https://cloud.example' }]);
    const backend = new OllamaRoutingBackend(config, { fetch: fetcher });
    expect(await backend.probe()).toMatchObject({ available: false, reachable: true, modelInstalled: false, lastError: expect.stringContaining('not installed') });
    expect(await backend.listModels()).toEqual(['other:1b']);
    expect(backend.getStatus().lastError).toContain('not installed');
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes('/pull'))).toBe(true);
  });

  it.each([
    ['not-json', 'not valid JSON'],
    [JSON.stringify({ ...answer, taskType: 'shell' }), 'JSON schema'],
    [JSON.stringify({ ...answer, confidence: -1 }), 'JSON schema'],
    [JSON.stringify({ ...answer, confidence: '0.9' }), 'JSON schema'],
    [JSON.stringify({ ...answer, command: 'do anything' }), 'JSON schema'],
  ])('rejects an invalid model result %s with a visible fallback reason', async (content, message) => {
    const backend = new OllamaRoutingBackend(config, { fetch: fixture(async () => response({ done: true, message: { content } })) });
    const local = new LocalRoutingModel({ classifier: backend });
    expect(await local.classify(task)).toMatchObject({ backend: 'heuristic', taskType: 'code', fallbackReason: expect.stringContaining(message) });
    expect(backend.getStatus()).toMatchObject({ available: false, lastError: expect.stringContaining(message) });
  });

  it('retains unsupported capability diagnostics', async () => {
    const backend = new OllamaRoutingBackend(config, { fetch: fixture(undefined, [{ name: config.model, capabilities: ['embedding'] }]) });
    expect(await backend.probe()).toMatchObject({ available: false, lastError: expect.stringContaining('does not support text completion') });
  });

  it('aborts the actual fetch at the foreground deadline, then falls back to rules', async () => {
    vi.useFakeTimers();
    const pendingRequest = blocked();
    const backend = new OllamaRoutingBackend({ ...config, timeoutMs: 250 }, { fetch: fixture(pendingRequest.chat) });
    const pending = new LocalRoutingModel({ classifier: backend }).classify(task);
    await vi.advanceTimersByTimeAsync(251);
    expect(await pending).toMatchObject({ backend: 'heuristic', fallbackReason: expect.stringContaining('timed out after 250 ms') });
    expect(pendingRequest.signal?.aborted).toBe(true);
    expect(backend.getStatus().lastError).toContain('timed out');
  });

  it('propagates user cancellation, aborts HTTP, and does not count it as a backend failure', async () => {
    const request = blocked();
    const backend = new OllamaRoutingBackend(config, { fetch: fixture(request.chat) });
    const cancel = new AbortController();
    const pending = new LocalRoutingModel({ classifier: backend }).classify(task, { signal: cancel.signal });
    await request.started;
    cancel.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
    expect(request.signal?.aborted).toBe(true);
    expect(backend.getStatus().circuitOpenUntil).toBeUndefined();
    expect(backend.getStatus().lastError).toBeUndefined();
  });

  it('opens the circuit after three failures and allows a new attempt after its cooldown', async () => {
    let now = 1000;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const backend = new OllamaRoutingBackend(config, { fetch: fetcher, now: () => now });
    for (let i = 0; i < 3; i += 1) await expect(backend.classify(task)).rejects.toThrow('unreachable');
    expect(backend.getStatus().circuitOpenUntil).toBe(16000);
    await expect(backend.classify(task)).rejects.toThrow('circuit is open');
    expect(fetcher).toHaveBeenCalledTimes(3);
    now = 16001;
    await expect(backend.classify(task)).rejects.toThrow('unreachable');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('keeps warmup in the background budget and immediately falls back while it is busy', async () => {
    vi.useFakeTimers();
    const request = blocked();
    const backend = new OllamaRoutingBackend({ ...config, timeoutMs: 250 }, { fetch: fixture(request.chat) });
    const warmup = backend.warmup();
    const completedWarmup = expect(warmup).rejects.toThrow('30000 ms');
    await vi.advanceTimersByTimeAsync(251);
    expect(request.signal?.aborted).toBe(false);
    expect(backend.getStatus().warmingUp).toBe(true);
    expect(await new LocalRoutingModel({ classifier: backend }).classify(task)).toMatchObject({ backend: 'heuristic', fallbackReason: expect.stringContaining('warming up') });
    await vi.advanceTimersByTimeAsync(30_000);
    await completedWarmup;
    expect(request.signal?.aborted).toBe(true);
    expect(backend.getStatus().circuitOpenUntil).toBeUndefined();
    expect(backend.getStatus().warmingUp).toBe(false);
  });

  it('warms the same confirmed-example prefix after a timeout while replacing only the current task', async () => {
    const fetcher = fixture();
    const backend = new OllamaRoutingBackend(config, { fetch: fetcher });
    const context = { ...task, confirmedExamples: [{ description: 'User-confirmed translation request', priorContext: 'Earlier text', taskType: 'general' as const, complexity: 'low' as const }] };
    const original = structuredClone(context);
    await backend.warmup(undefined, context);
    const call = fetcher.mock.calls.find(([url]) => String(url).endsWith('/api/chat'))!;
    const body = JSON.parse(String(call[1]?.body));
    expect(body.messages[0].content).toBe(buildRoutingPrompt({ ...context, type: 'general', description: '你好。' }));
    expect(body.messages[0].content).toContain('User-confirmed translation request');
    expect(body.messages[0].content).toContain('Earlier text');
    expect(body.messages[0].content).not.toContain(task.description);
    expect(context).toEqual(original);
    expect(backend.getStatus()).toMatchObject({ available: true, loaded: true, warmingUp: false });
  });

  it('stops its own request on dispose and never asks Ollama to stop or unload', async () => {
    const request = blocked();
    const fetcher = fixture(request.chat);
    const backend = new OllamaRoutingBackend(config, { fetch: fetcher });
    const pending = backend.classify(task);
    await request.started;
    backend.dispose();
    await expect(pending).rejects.toThrow('disposed');
    expect(request.signal?.aborted).toBe(true);
    expect(backend.getStatus().available).toBe(false);
    expect(fetcher.mock.calls.every(([url]) => ['/api/version', '/api/tags', '/api/ps', '/api/chat'].includes(new URL(String(url)).pathname))).toBe(true);
  });
});
