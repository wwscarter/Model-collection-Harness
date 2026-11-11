import { describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import type { MediaRequest } from '../../src/core/media/MediaTypes';
import { ImageProviderError, OpenAIImagesProvider } from '../../src/core/media/providers/OpenAIImagesProvider';
import { pngImage } from '../helpers/png';

const model: ModelConfig = {
  id: 'gateway-image', provider: 'custom', name: 'Gateway image', apiKey: 'synthetic-private-api-key',
  baseURL: 'https://gateway.example/v1?api_key=synthetic-private-query-key', modelId: 'gateway-image-model',
  operations: { 'image.generate': { protocol: 'openai-images' } },
  costPer1kTokens: { input: 0, output: 0 }, capabilities: [], maxTokens: 2000,
  rateLimit: { requestsPerMinute: 0, tokensPerDay: 0 }, enabled: true, priority: 0,
  createdAt: new Date(), updatedAt: new Date(),
};
const request: MediaRequest = { operation: 'image.generate', prompt: 'A quiet mountain landscape.' };
function response(image = pngImage(2, 2)): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: image }] }), { headers: { 'content-type': 'application/json' } });
}
function fixture(reply: () => Response = () => response()) {
  const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => reply());
  return { provider: new OpenAIImagesProvider(fetcher as typeof fetch), fetcher };
}

describe('image provider delegates generation capabilities to the endpoint', () => {
  it('passes explicit generation options without consulting declared model capabilities', async () => {
    const { provider, fetcher } = fixture();
    await provider.generate(model, { ...request, size: '1920x1080', format: 'webp', quality: 'high', transparentBackground: true });
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://gateway.example/v1/images/generations?api_key=synthetic-private-query-key');
    expect(options?.headers).toMatchObject({ authorization: 'Bearer ' + model.apiKey });
    expect(JSON.parse(String(options?.body))).toEqual({
      model: model.modelId, prompt: request.prompt, n: 1, size: '1920x1080', output_format: 'webp', quality: 'high', background: 'transparent',
    });
  });

  it('passes auto size through unchanged without choosing an application size', async () => {
    const { provider, fetcher } = fixture();
    await provider.generate(model, { ...request, size: 'auto' });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ size: 'auto', prompt: request.prompt });
  });

  it('uses the endpoint default format when no output format was requested', async () => {
    const { provider, fetcher } = fixture();
    await provider.generate(model, request);
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body).toEqual({ model: model.modelId, prompt: request.prompt, n: 1 });
    expect(body).not.toHaveProperty('output_format');
  });

  it('appends ratio and minimum targets to the original prompt without inventing protocol fields or dimensions', async () => {
    const { provider, fetcher } = fixture();
    await provider.generate(model, { ...request, aspectRatio: '16:9', minSize: '1920x1080' });
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.prompt).toBe(request.prompt + '\n\nImage output requirements:\nRequested aspect ratio: 16:9.\nRequested minimum image dimensions (width x height): 1920x1080.');
    expect(body).not.toHaveProperty('size');
    expect(body).not.toHaveProperty('aspectRatio');
    expect(body).not.toHaveProperty('minSize');
  });

  it('returns actual image bytes and metadata even when dimensions, ratio, minimum and format differ from requested targets', async () => {
    const encoded = pngImage(1672, 941);
    const { provider } = fixture(() => response(encoded));
    const result = await provider.generate(model, { ...request, size: '1920x1080', minSize: '2048x1152', aspectRatio: '1:1', format: 'webp' });
    expect(result.images).toEqual([{ bytes: Buffer.from(encoded, 'base64'), width: 1672, height: 941, mimeType: 'image/png', extension: 'png' }]);
  });

  it('reports bounded upstream reasons while redacting API credentials in both message and code', async () => {
    const { provider } = fixture(() => new Response(JSON.stringify({ error: {
      code: 'invalid_size_' + model.apiKey,
      message: 'Unsupported size 1920x1080. api_key=' + model.apiKey + '; token=synthetic-private-query-key; Authorization: Bearer unrelated-private-bearer',
    } }), { status: 400 }));
    const error = await provider.generate(model, request).catch((value: unknown) => value) as ImageProviderError;
    expect(error).toBeInstanceOf(ImageProviderError);
    expect(error).toMatchObject({ safeToRetry: true, code: 'MEDIA_PROVIDER_REJECTED' });
    expect(error.message).toContain('HTTP 400');
    expect(error.message).toContain('invalid_size_');
    expect(error.message).toContain('Unsupported size 1920x1080');
    for (const secret of [model.apiKey, 'synthetic-private-query-key', 'unrelated-private-bearer']) expect(error.message).not.toContain(secret);
    expect(error.message).toContain('[redacted]');
    expect(error.message.length).toBeLessThan(550);
  });

  it('keeps 5xx errors unsafe to retry even when the upstream provides a detailed reason', async () => {
    const { provider } = fixture(() => new Response(JSON.stringify({ error: { code: 'gateway_timeout', message: 'Generation acceptance could not be confirmed.' } }), { status: 502 }));
    await expect(provider.generate(model, request)).rejects.toMatchObject({
      code: 'MEDIA_RESULT_UNKNOWN', safeToRetry: false, message: expect.stringContaining('gateway_timeout — Generation acceptance could not be confirmed.'),
    });
  });

  it('stops reading oversized upstream errors and retains the HTTP rejection classification', async () => {
    let reads = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads += 1; controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    const { provider } = fixture(() => new Response(body, { status: 400 }));
    await expect(provider.generate(model, request)).rejects.toMatchObject({ safeToRetry: true, message: '图片生成接口返回 HTTP 400' });
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThan(20);
  });

  it('returns a known safe HTTP rejection after a stalled body timeout even when cancellation never settles', async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; return new Promise<void>(() => undefined); },
      });
      const { provider } = fixture(() => new Response(body, { status: 400 }));
      const result = provider.generate(model, request).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await result).toMatchObject({ safeToRetry: true, code: 'MEDIA_PROVIDER_REJECTED', message: '图片生成接口返回 HTTP 400' });
      expect(cancelled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('clears the optional diagnostic timer when an upstream error arrives promptly', async () => {
    vi.useFakeTimers();
    try {
      const { provider } = fixture(() => new Response(JSON.stringify({ error: { code: 'invalid_size', message: 'Unsupported dimensions' } }), { status: 400 }));
      await expect(provider.generate(model, request)).rejects.toMatchObject({ safeToRetry: true, message: expect.stringContaining('invalid_size — Unsupported dimensions') });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('caps ordinary upstream error messages and tolerates non-JSON rejection bodies', async () => {
    const { provider } = fixture(() => new Response(JSON.stringify({ error: { message: 'bad image option '.repeat(200) } }), { status: 422 }));
    const error = await provider.generate(model, request).catch((value: unknown) => value) as ImageProviderError;
    expect(error.safeToRetry).toBe(true);
    expect(error.message.length).toBeLessThan(550);
    const nonJson = fixture(() => new Response('<html>Gateway unavailable</html>', { status: 503 })).provider;
    await expect(nonJson.generate(model, request)).rejects.toMatchObject({ safeToRetry: false, message: '图片生成接口返回 HTTP 503' });
  });

  it('continues rejecting invalid image bytes rather than treating a non-image response as an asset', async () => {
    const { provider } = fixture(() => response(Buffer.from('not an image').toString('base64')));
    await expect(provider.generate(model, request)).rejects.toMatchObject({ safeToRetry: false, code: 'MEDIA_RESULT_UNKNOWN' });
  });
});
