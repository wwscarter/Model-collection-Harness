import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { MediaExecutionService } from '../../src/core/media/MediaExecutionService';
import { routeMediaRequest } from '../../src/core/media/MediaRouting';
import { createMediaTools } from '../../src/core/media/MediaTools';
import { normalizeMediaArtifacts, type MediaExecutionContext } from '../../src/core/media/MediaTypes';
import { resolveImagesEndpoint } from '../../src/core/media/providers/OpenAIImagesProvider';
import { BudgetExceededError } from '../../src/core/routing/RunBudget';
import { pngImage } from '../helpers/png';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function model(id: string, score = 80, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { id, provider: 'custom', name: id, apiKey: '', baseURL: 'https://gateway.example/v1?tenant=x', modelId: 'image-' + id, operations: { 'image.generate': { protocol: 'openai-images', score, estimatedCostUsd: 0.03 } }, costPer1kTokens: { input: 0, output: 0 }, capabilities: [], maxTokens: 2000, rateLimit: { requestsPerMinute: 0, tokensPerDay: 0 }, enabled: true, priority: 0, createdAt: new Date(), updatedAt: new Date(), ...overrides };
}
function response(usage?: unknown) { return new Response(JSON.stringify({ data: [{ b64_json: png }], ...(usage ? { usage } : {}) }), { status: 200, headers: { 'content-type': 'application/json' } }); }
function fixture(models = [model('a')], fetcher = vi.fn(async () => response())) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-media-')); directories.push(directory);
  return { directory, fetcher, service: new MediaExecutionService({ dataDir: directory, models: { getAllModels: () => models }, fetch: fetcher as typeof fetch }) };
}
const context: MediaExecutionContext = { rootRunId: 'run-1', sessionId: 'session-1', assistantMessageId: 'assistant-1', agentId: 'codex' };
const request = { operation: 'image.generate' as const, prompt: 'A blue city skyline', artifactSlot: 'landing.hero' };

describe('dynamic media model routing', () => {
  it('selects from multiple models and hard capability constraints dominate quality', () => {
    const high = model('high', 99); const transparent = model('transparent', 70, { operations: { 'image.generate': { protocol: 'openai-images', score: 70, limits: { transparentBackground: true, sizes: ['1536x864'], formats: ['png'] } } } });
    expect(routeMediaRequest({ ...request, transparentBackground: true, aspectRatio: '16:9' }, [high, transparent])[0].model.id).toBe('transparent');
    expect(routeMediaRequest(request, [high, transparent])[0].model.id).toBe('high');
  });
  it('routes by estimated request cost or speed without treating unknown values as zero', () => {
    const cheap = model('cheap', 20, { operations: { 'image.generate': { protocol: 'openai-images', score: 20, estimatedCostUsd: 0.01, expectedDurationMs: 10000 } } });
    const fast = model('fast', 90, { operations: { 'image.generate': { protocol: 'openai-images', score: 90, estimatedCostUsd: 0.1, expectedDurationMs: 1000 } } });
    const unknown = model('unknown', 100, { operations: { 'image.generate': { protocol: 'openai-images', score: 100 } } });
    expect(routeMediaRequest({ ...request, preference: 'cost' }, [unknown, fast, cheap])[0].model.id).toBe('cheap');
    expect(routeMediaRequest({ ...request, preference: 'speed' }, [unknown, cheap, fast])[0].model.id).toBe('fast');
  });
  it('requires configured quality, dimensions and output format for explicit hard constraints', () => {
    const candidate = model('image');
    expect(() => routeMediaRequest({ ...request, size: '1536x864' }, [candidate])).toThrow('未声明指定尺寸');
    expect(() => routeMediaRequest({ ...request, format: 'webp' }, [candidate])).toThrow('未声明指定格式');
    expect(() => routeMediaRequest({ ...request, quality: 'high' }, [candidate])).toThrow('未声明指定质量');
    candidate.operations = { 'image.generate': { protocol: 'openai-images', limits: { sizes: ['1536x864'], formats: ['webp'], qualities: ['high'] } } };
    expect(routeMediaRequest({ ...request, size: '1536x864', format: 'webp', quality: 'high' }, [candidate])[0].request).toMatchObject({ size: '1536x864', format: 'webp', quality: 'high' });
  });
  it('selects the nearest declared size only for an explicit minimum, preserving exact sizes', () => {
    const candidate = model('image', 80, { operations: { 'image.generate': { protocol: 'openai-images', limits: { sizes: ['2560x1440', '1672x941', '2048x1152'] } } } });
    const routed = routeMediaRequest({ ...request, minSize: '1920x1080', aspectRatio: '16:9' }, [candidate])[0];
    expect(routed.request.size).toBe('2048x1152');
    expect(routed.request.minSize).toBe('1920x1080');
    expect(routed.reason).toContain('不小于目标的最近档位 2048x1152');
    expect(() => routeMediaRequest({ ...request, size: '1920x1080', aspectRatio: '16:9' }, [candidate])).toThrow('不支持指定精确尺寸 1920x1080');
  });
  it('rejects a declared size set whose largest matching ratio is still below the target', () => {
    const candidate = model('gpt-image', 80, { operations: { 'image.generate': { protocol: 'openai-images', limits: { sizes: ['1672x941', '2560x1024'] } } } });
    expect(() => routeMediaRequest({ ...request, minSize: '1920x1080' }, [candidate])).toThrow('没有不小于目标尺寸 1920x1080');
    expect(() => routeMediaRequest({ ...request, size: '1672x941', minSize: '1920x1080' }, [candidate])).toThrow('精确图片尺寸小于');
  });
  it('uses a declared default size for a matching ratio and respects explicit size limits', () => {
    const candidate = model('default', 80, { operations: { 'image.generate': { protocol: 'openai-images', defaults: { size: '1920x1080' } } } });
    expect(routeMediaRequest({ ...request, aspectRatio: '16:9' }, [candidate])[0].request.size).toBe('1920x1080');
    candidate.operations!['image.generate']!.limits = { sizes: ['1024x1024'] };
    expect(() => routeMediaRequest({ ...request, aspectRatio: '16:9' }, [candidate])).toThrow('没有满足指定比例');
  });
  it('does not infer gateway size support from a model name', () => {
    const candidate = model('gpt-image', 80, { modelId: 'gpt-image-2.6-sunburst' });
    expect(() => routeMediaRequest({ ...request, aspectRatio: '16:9' }, [candidate])).toThrow('模型与端点 → 图片生成 → 支持的尺寸');
    expect(() => routeMediaRequest({ ...request, minSize: '1920x1080' }, [candidate])).toThrow('无法保证最小尺寸');
  });
  it('rejects invalid and excessive requested dimensions before routing', () => {
    expect(() => routeMediaRequest({ ...request, size: '0x0' }, [model('image')])).toThrow('WIDTHxHEIGHT');
    expect(() => routeMediaRequest({ ...request, size: '32768x32768' }, [model('image')])).toThrow('超出应用限制');
    expect(() => routeMediaRequest({ ...request, minSize: '32768x32768' }, [model('image')])).toThrow('超出应用限制');
  });
  it('never uses legacy text or unconfigured video models', () => {
    expect(() => routeMediaRequest(request, [model('text', 100, { operations: undefined })])).toThrow('没有满足');
    expect(() => routeMediaRequest({ ...request, operation: 'video.generate' }, [model('video', 100, { operations: { 'video.generate': { protocol: 'unconfigured' } } })])).toThrow('视频生成协议');
  });
  it('persists a required failure when no candidate exists, then safely retries the same slot if capability appears', async () => {
    let models: ModelConfig[] = [];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-media-')); directories.push(directory);
    const fetcher = vi.fn(async () => response());
    const service = new MediaExecutionService({ dataDir: directory, models: { getAllModels: () => models }, fetch: fetcher as typeof fetch });
    await expect(service.execute(request, context)).rejects.toMatchObject({ code: 'MEDIA_MODEL_UNAVAILABLE', details: { required: true, jobId: expect.any(String) } });
    expect(service.listJobs()[0]).toMatchObject({ required: true, status: 'failed', attempts: [] });
    models = [model('image')];
    const result = await service.execute(request, context);
    expect(result.job).toMatchObject({ required: true, status: 'succeeded' }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('media protocol and durable execution', () => {
  it('keeps prompt dimensions when a tool retry removes structured constraints and bumps its revision', async () => {
    const { service, fetcher } = fixture([model('gpt-image')]);
    const tool = createMediaTools(service, context)[0];
    const prompt = '生成一张风景图片。目标画布：1920×1080，16:9 横幅。';
    for (const args of [
      { ...request, prompt, size: '1920x1080', aspectRatio: '16:9' },
      { ...request, prompt, revision: 1 },
    ]) {
      const result = await tool.execute('call', args, undefined, undefined, {} as never);
      expect(result).toMatchObject({ isError: true, details: { code: 'MEDIA_MODEL_UNAVAILABLE', required: true } });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(service.listJobs()).toHaveLength(2);
    for (const job of service.listJobs()) expect(job).toMatchObject({ status: 'failed', attempts: [], request: { size: '1920x1080', aspectRatio: '16:9' } });
  });
  it('rejects a tool parameter that contradicts explicit prompt dimensions before generation', async () => {
    const { service, fetcher } = fixture();
    await expect(service.execute({ ...request, prompt: '目标画布：1920×1080', size: '1672x941' }, context)).rejects.toMatchObject({ code: 'MEDIA_CONSTRAINT_CONFLICT' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects an undersized real PNG without resubmitting or reporting a completed asset', async () => {
    const candidate = model('wide', 90, { operations: { 'image.generate': { protocol: 'openai-images', limits: { sizes: ['2048x1152'] } } } });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: pngImage(1672, 941) }] })));
    const { service, directory } = fixture([candidate, { ...candidate, id: 'fallback' }], fetcher);
    const input = { ...request, prompt: '生成至少1920×1080的16:9风景图片' };
    await expect(service.execute(input, context)).rejects.toMatchObject({ code: 'MEDIA_RESULT_UNKNOWN', message: expect.stringContaining('1672x941 小于要求的最小尺寸 1920x1080') });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(service.listArtifacts(context.rootRunId)).toEqual([]);
    const [, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ size: '2048x1152' });
    const restored = new MediaExecutionService({ dataDir: directory, models: { getAllModels: () => [candidate] }, fetch: fetcher as typeof fetch });
    await expect(restored.execute(input, context)).rejects.toMatchObject({ code: 'MEDIA_RESULT_UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves gateway paths/query and refuses text endpoint addresses', () => {
    expect(resolveImagesEndpoint('https://gateway.example/proxy/v1?tenant=x')).toBe('https://gateway.example/proxy/v1/images/generations?tenant=x');
    expect(resolveImagesEndpoint('https://gateway.example/v1/images/generations')).toBe('https://gateway.example/v1/images/generations');
    expect(() => resolveImagesEndpoint('https://gateway.example/v1/chat/completions')).toThrow('不要填写文本接口');
  });
  it('sends image payload, saves actual bytes and restores artifacts after restart', async () => {
    const { service, fetcher, directory } = fixture(); const result = await service.execute(request, context);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/images/generations?tenant=x');
    expect(JSON.parse(String(options.body))).toEqual({ model: 'image-a', prompt: request.prompt, n: 1, output_format: 'png' });
    expect(options.headers).toEqual({ 'content-type': 'application/json' });
    expect(result.artifacts[0]).toMatchObject({ kind: 'image', width: 1, height: 1, modelId: 'image-a', configurationId: 'a' });
    expect(service.readAsset(result.artifacts[0].id).bytes.equals(Buffer.from(png, 'base64'))).toBe(true);
    const restored = new MediaExecutionService({ dataDir: directory, models: { getAllModels: () => [model('a')] } });
    expect(restored.listArtifacts(context.rootRunId)).toEqual(result.artifacts);
    expect((await restored.execute(request, context)).artifacts).toEqual(result.artifacts);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('deduplicates concurrent workers but rejects changed requirements for the same slot', async () => {
    let finish!: () => void; const pending = new Promise<void>((resolve) => { finish = resolve; });
    const fetcher = vi.fn(async () => { await pending; return response(); }); const { service } = fixture(undefined, fetcher);
    const first = service.execute(request, context); const second = service.execute(request, { ...context, agentId: 'deepseek' }); finish();
    const [a, b] = await Promise.all([first, second]);
    expect(a.job.id).toBe(b.job.id); expect(a.job.required).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(service.execute({ ...request, prompt: 'different requirement' }, context)).rejects.toMatchObject({ code: 'MEDIA_REQUEST_CONFLICT' });
  });
  it('only falls back after explicit rejection and records each attempted model', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429 })).mockResolvedValueOnce(response());
    const { service } = fixture([model('first', 90), model('second', 80)], fetcher);
    const result = await service.execute(request, context);
    expect(result.job.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'succeeded']);
    expect(result.job.error).toBeUndefined();
    expect(result.artifacts[0].configurationId).toBe('second');
  });
  it('does not resubmit uncertain creation on another model or after restarting', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('connection reset'));
    const { service, directory } = fixture([model('a', 90), model('b', 80)], fetcher);
    await expect(service.execute(request, context)).rejects.toMatchObject({ code: 'MEDIA_RESULT_UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(service.listJobs()[0].status).toBe('unknown');
    const restored = new MediaExecutionService({ dataDir: directory, models: { getAllModels: () => [model('b')] }, fetch: fetcher });
    await expect(restored.execute(request, context)).rejects.toMatchObject({ code: 'MEDIA_RESULT_UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects missing cost estimate before an external call and respects quota and strict overrides', async () => {
    const a = model('a', 90, { operations: { 'image.generate': { protocol: 'openai-images' } } });
    const { service, fetcher } = fixture([a, model('b', 80)]); const budget = { reserve: vi.fn(), settle: vi.fn() };
    await expect(service.execute(request, { ...context, budget, modelId: 'a' })).rejects.toMatchObject({ code: 'MEDIA_ESTIMATE_REQUIRED' }); expect(fetcher).not.toHaveBeenCalled();
    const result = await service.execute({ ...request, revision: 1 }, { ...context, quota: { isAvailable: (m) => m.id === 'b', reserve: vi.fn(), record: vi.fn() } });
    expect(result.job.configurationId).toBe('b');
  });
  it('does not claim unknown billing is zero and releases explicitly rejected reservations', async () => {
    const { service } = fixture(); const budget = { reserve: vi.fn(), settle: vi.fn() };
    const result = await service.execute(request, { ...context, budget });
    expect(budget.reserve).toHaveBeenCalledWith(expect.any(String), 0.03);
    expect(budget.settle).toHaveBeenCalledWith(expect.any(String), undefined);
    expect(result.job.costStatus).toBe('estimated'); expect(result.job.actualCostUsd).toBeUndefined();
  });
  it('skips unknown cost candidates and reroutes to an affordable compatible candidate before sending', async () => {
    const unknown = model('unknown', 100, { operations: { 'image.generate': { protocol: 'openai-images', score: 100 } } });
    const expensive = model('expensive', 90, { operations: { 'image.generate': { protocol: 'openai-images', score: 90, estimatedCostUsd: 0.8 } } });
    const cheap = model('cheap', 70, { operations: { 'image.generate': { protocol: 'openai-images', score: 70, estimatedCostUsd: 0.02 } } });
    const { service, fetcher } = fixture([unknown, expensive, cheap]);
    const reserve = vi.fn((_id: string, estimate?: number) => { if (estimate! > 0.1) throw new BudgetExceededError('媒体费用超过剩余预算'); });
    const result = await service.execute(request, { ...context, budget: { reserve, settle: vi.fn() } });
    expect(result.job.attempts.map((attempt) => [attempt.configurationId, attempt.status])).toEqual([['expensive', 'failed'], ['cheap', 'succeeded']]);
    expect(result.job.configurationId).toBe('cheap'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)).model).toBe('image-cheap');
  });
  it('rejects non-image responses and retains unknown state instead of accepting text', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] })));
    const { service } = fixture(undefined, fetcher);
    await expect(service.execute(request, context)).rejects.toMatchObject({ code: 'MEDIA_RESULT_UNKNOWN' }); expect(service.listArtifacts(context.rootRunId)).toEqual([]);
  });
  it('exports into the project idempotently but blocks escapes and symlinks', async () => {
    const { service, directory } = fixture(); const { artifacts } = await service.execute(request, context);
    const project = path.join(directory, 'project'); fs.mkdirSync(project);
    expect(service.exportAsset(artifacts[0].id, 'assets/hero.png', project).path).toBe('assets/hero.png');
    expect(service.exportAsset(artifacts[0].id, 'assets/hero.png', project).path).toBe('assets/hero.png');
    expect(() => service.exportAsset(artifacts[0].id, '../escape.png', project)).toThrow('超出项目');
    fs.symlinkSync(directory, path.join(project, 'linked'));
    expect(() => service.exportAsset(artifacts[0].id, 'linked/escape.png', project)).toThrow('符号链接');
  });
  it('keeps media request capability separate from project export and scopes job queries', async () => {
    const { service } = fixture(); const tools = createMediaTools(service, context);
    expect(tools.map((tool) => tool.name)).toEqual(['request_media', 'get_media_job']);
    const result = await service.execute(request, context);
    const query = createMediaTools(service, { ...context, sessionId: 'another-session' })[1];
    expect((await query.execute('tool-1', { jobId: result.job.id }, undefined, undefined, {} as never)).isError).toBe(true);
    expect(normalizeMediaArtifacts([{ ...result.artifacts[0], fileName: '../escape.png' }])).toEqual([]);
    expect(normalizeMediaArtifacts([{ ...result.artifacts[0], id: '01234567-89ab-4cde-8fab-0123456789ab', fileName: '..' }])).toEqual([]);
  });
  it('does not share a job or asset between sessions even when rootRunIds collide', async () => {
    const { service, fetcher } = fixture();
    const first = await service.execute(request, { ...context, rootRunId: 'collision', sessionId: 'session-a' });
    const second = await service.execute(request, { ...context, rootRunId: 'collision', sessionId: 'session-b' });
    expect(first.job.id).not.toBe(second.job.id); expect(first.artifacts[0].id).not.toBe(second.artifacts[0].id); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(service.listArtifacts('collision', 'session-a')).toEqual(first.artifacts);
    expect(service.listArtifacts('collision', 'session-b')).toEqual(second.artifacts);
  });
  it('does not silently reuse an asset created by a different strict model override', async () => {
    const { service } = fixture([model('a'), model('b')]);
    await service.execute(request, { ...context, modelId: 'a' });
    await expect(service.execute(request, { ...context, modelId: 'b' })).rejects.toMatchObject({ code: 'MEDIA_REQUEST_CONFLICT' });
  });
  it('returns a required error for a media tool whose request cannot execute', async () => {
    const { service } = fixture([]); const tool = createMediaTools(service, context)[0];
    const result = await tool.execute('call', request, undefined, undefined, {} as never);
    expect(result).toMatchObject({ isError: true, details: { required: true, code: 'MEDIA_MODEL_UNAVAILABLE', details: { required: true } } });
  });
  it('does not choose another supplier when the endpoint responds with a creation conflict', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 409 }));
    const { service } = fixture([model('a', 90), model('b', 80)], fetcher);
    await expect(service.execute(request, context)).rejects.toMatchObject({ code: 'MEDIA_RESULT_UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('marks a success response unknown when returned dimensions violate the routed size', async () => {
    const constrained = model('wide', 90, { operations: { 'image.generate': { protocol: 'openai-images', score: 90, limits: { sizes: ['1536x864'] } } } });
    const { service } = fixture([constrained]);
    await expect(service.execute({ ...request, aspectRatio: '16:9' }, context)).rejects.toMatchObject({ code: 'MEDIA_RESULT_UNKNOWN' });
    expect(service.listJobs()[0]).toMatchObject({ status: 'unknown', error: '图片接口返回尺寸与请求不符：实际 1x1，请求 1536x864' });
  });
  it('deletes session media after active creation settles without recreating deleted assets', async () => {
    let finish!: () => void; const pending = new Promise<void>((resolve) => { finish = resolve; });
    const { service, directory } = fixture(undefined, vi.fn(async () => { await pending; return response(); }));
    const execution = service.execute(request, context); const deletion = service.deleteSession(context.sessionId); finish();
    const result = await execution; await deletion;
    expect(service.listJobs()).toEqual([]); expect(() => service.readAsset(result.artifacts[0].id)).toThrow('不存在');
    expect(fs.readdirSync(path.join(directory, 'media', 'assets'))).toEqual([]);
    await expect(service.execute({ ...request, revision: 1 }, context)).rejects.toMatchObject({ code: 'MEDIA_SESSION_DELETED' });
  });
});
