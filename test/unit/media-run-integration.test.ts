import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore, type Core, type CreateCoreOptions } from '../../src/core/bootstrap/createCore';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import type { MediaArtifact, MediaResult } from '../../src/core/media/MediaTypes';
import type { RunDependencies } from '../../src/core/agent/RunCoordinator';
import { DEFAULT_ROUTING_SETTINGS } from '../../src/core/routing/RoutingSettings';
import { pngImage } from '../helpers/png';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); });
function textModel(id: string, baseURL: string, priority = 0): ModelConfig {
  return {
    id, modelId: id, name: id, provider: 'custom', apiKey: '', baseURL, enabled: true, priority,
    maxTokens: 4096, contextWindow: 64_000, capabilities: [{ type: 'code', score: 95 - priority }],
    costPer1kTokens: { input: 0, output: 0 }, rateLimit: { requestsPerMinute: 0, tokensPerDay: 0 }, createdAt: new Date(), updatedAt: new Date(),
  };
}
function imageModel(id: string, baseURL: string, score = 80, estimate: number | undefined = 0.03): ModelConfig {
  return { ...textModel(id, baseURL), capabilities: [], operations: { 'image.generate': { protocol: 'openai-images', score, ...(estimate === undefined ? {} : { estimatedCostUsd: estimate }) } } };
}
async function fixture(options: {
  models?: (baseURL: string) => ModelConfig[];
  parallel?: boolean;
  maxCostUsd?: number;
  invokeStreamed?: RunDependencies['invokeStreamed'];
  createProvider?: RunDependencies['createProvider'];
  sdk?: boolean;
  imageSize?: [number, number];
} = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-media-run-')));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests: Array<{ path: string; body: any }> = [];
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ path: request.url!, body: JSON.parse(body || '{}') });
      if (options.sdk && request.url === '/v1/chat/completions') {
        const textCalls = requests.filter((entry) => entry.path === '/v1/chat/completions').length;
        const delta = textCalls === 1 ? { tool_calls: [{ index: 0, id: 'sdk-media', type: 'function', function: { name: 'request_media', arguments: JSON.stringify({ operation: 'image.generate', prompt: 'A blue skyline', artifactSlot: 'landing.hero' }) } }] } : { content: '页面与真实配图已完成。' };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: textCalls === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n'); return;
      }
      if (request.url !== '/v1/images/generations') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Unexpected text request in media integration fixture' } })); return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: options.imageSize ? pngImage(...options.imageSize) : png }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => { server.closeAllConnections(); server.close(); });
  const baseURL = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
  fs.writeFileSync(path.join(directory, 'routing-rules.json'), JSON.stringify({ version: 1, defaults: { strategy: options.parallel ? 'parallel' : 'single' }, rules: [] }));
  const events: Array<{ channel: string; payload: any }> = [];
  const invocation = options.invokeStreamed ?? vi.fn(async () => { throw new Error('A pure media request must not invoke a text model'); });
  const core = await createCore({ dataDir: directory, confirm: () => true, emit: (channel, payload) => events.push({ channel, payload }) }, {
    initializePresets: false, enableMcp: false, approvalMode: 'auto', ...(options.sdk ? {} : { invokeStreamed: invocation }),
    ...(options.createProvider ? { createProvider: options.createProvider } : {}),
    models: options.models?.(baseURL) ?? [textModel('text', baseURL), imageModel('image', baseURL)],
  } satisfies CreateCoreOptions);
  cleanup.push(() => core.dispose());
  core.routingService.save({ ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'off' }, budget: { maxCostUsd: options.maxCostUsd ?? 0.25, maxDurationMs: 60_000 } });
  return { core, directory, baseURL, requests, events, invocation };
}

describe('media generation in the shared core run pipeline', () => {
  it('sends the next supported size for an explicit minimum and persists the original requirement', async () => {
    const { core, requests, directory } = await fixture({ imageSize: [2048, 1152], models: (baseURL) => {
      const image = imageModel('image', baseURL);
      image.operations!['image.generate']!.limits = { sizes: ['1672x941', '2048x1152', '2560x1440'] };
      return [image];
    } });
    const output = await core.run({ runId: 'minimum-image', sessionId: 'minimum-session', prompt: '生成一张至少1920×1080的16:9图片' });
    expect(output.artifacts).toEqual([expect.objectContaining({ width: 2048, height: 1152 })]);
    expect(requests).toEqual([{ path: '/v1/images/generations', body: { model: 'image', prompt: '生成一张至少1920×1080的16:9图片', size: '2048x1152', n: 1, output_format: 'png' } }]);
    const job = core.media.listJobs('minimum-image')[0];
    expect(job.request).toMatchObject({ minSize: '1920x1080', aspectRatio: '16:9' });
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'media', 'jobs', job.id + '.json'), 'utf8'));
    expect(saved.request).toMatchObject({ minSize: '1920x1080', aspectRatio: '16:9' });
    expect(saved.artifacts).toEqual(output.artifacts);
  });

  it('keeps a compound run incomplete when a retry drops fields still required by its prompt', async () => {
    const invoke: RunDependencies['invokeStreamed'] = async (model, _prompt, _max, onDelta, options) => {
      const tool = options!.mediaTools!.find((candidate) => candidate.name === 'request_media')!;
      for (const revision of [0, 1]) {
        const args = { operation: 'image.generate', prompt: '目标画布：1920×1080，16:9。', artifactSlot: 'landing.hero', revision, ...(revision === 0 ? { size: '1920x1080', aspectRatio: '16:9' } : {}) };
        const toolCallId = 'drop-constraints-' + revision;
        options!.onToolEvent?.({ toolCallId, toolName: tool.name, status: 'running', args });
        const result = await tool.execute(toolCallId, args, options!.signal, undefined, {} as never);
        expect(result.isError).toBe(true);
        options!.onToolEvent?.({ toolCallId, toolName: tool.name, status: 'failed', details: result.details });
      }
      onDelta('页面已完成。');
      return { modelId: model.id, content: '页面已完成。', inputTokens: 25, outputTokens: 9 };
    };
    const { core, requests } = await fixture({ invokeStreamed: invoke });
    const output = await core.run({ runId: 'size-required', sessionId: 'size-session', prompt: '开发一个页面并生成1920×1080背景图', includeProjectContext: false });
    expect(output.stopReason).toBe('media_incomplete');
    expect(output.output).toContain('尚未完整交付');
    expect(requests).toEqual([]);
    expect(core.media.listArtifacts('size-required')).toEqual([]);
  });
  it('publishes a single confirmation and binds execution to the reviewed media request', async () => {
    const { core, requests, events } = await fixture();
    const output = await core.run({ runId: 'confirmed-image', sessionId: 'confirmation-session', prompt: '生成一张海报', planningMode: 'confirm' });
    expect(requests).toHaveLength(1);
    expect(output.artifacts).toHaveLength(1);
    expect(events.filter((event) => event.channel === 'session:plan' && event.payload.status === 'awaiting')).toHaveLength(1);
    expect(core.plans.latest('confirmed-image')).toMatchObject({ editable: false, status: 'completed' });
  });

  it('rejects conflicting explicit media parameters before any generation', async () => {
    const { core, requests } = await fixture();
    await expect(core.run({ prompt: '生成1536x864的PNG图片', media: { size: '1024x1024', format: 'webp' } })).rejects.toThrow('MEDIA_CONSTRAINT_CONFLICT');
    expect(requests).toEqual([]);
  });

  it('reports a required failed media dependency in text and skips model verification and memory extraction', async () => {
    const createProvider = vi.fn<NonNullable<RunDependencies['createProvider']>>(() => { throw new Error('Incomplete media must not trigger model verification or extraction'); });
    const invoke: RunDependencies['invokeStreamed'] = async (model, _prompt, _max, onDelta, options) => {
      const tool = options!.mediaTools!.find((candidate) => candidate.name === 'request_media')!;
      const args = { operation: 'image.generate', prompt: 'A blue skyline', artifactSlot: 'landing.hero' };
      options!.onToolEvent?.({ toolCallId: 'missing-media', toolName: tool.name, status: 'running', args });
      const result = await tool.execute('missing-media', args, options!.signal, undefined, {} as never);
      expect(result.isError).toBe(true);
      options!.onToolEvent?.({ toolCallId: 'missing-media', toolName: tool.name, status: 'failed', details: result.details });
      const content = '实现已完成。\n\n' + String.fromCharCode(96).repeat(3) + 'ts\nconst ready = true;\n' + String.fromCharCode(96).repeat(3);
      onDelta(content);
      return { modelId: model.id, content, inputTokens: 25, outputTokens: 9 };
    };
    const { core, requests } = await fixture({ invokeStreamed: invoke, createProvider, models: (baseURL) => [textModel('executor', baseURL), textModel('utility', baseURL, 5)] });
    core.memoryStore.setAutoExtract(true);
    const output = await core.run({ runId: 'missing-dependency', sessionId: 'missing-session', taskType: 'code', complexity: 'high', prompt: '开发一个产品页面并生成背景图', includeProjectContext: false });
    expect(output.stopReason).toBe('media_incomplete');
    expect(output.output).toContain('所需媒体素材未完成，本轮任务尚未完整交付');
    expect(output.output).toContain('landing.hero');
    expect(core.observability.getTrace('missing-dependency')?.run.status).toBe('failed');
    expect(output.metrics).toMatchObject({ stopReason: 'media_incomplete' });
    expect(createProvider).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('recovers from an invalid no-job media call after a successful retry for the same asset slot', async () => {
    const invoke: RunDependencies['invokeStreamed'] = async (model, _prompt, _max, onDelta, options) => {
      const tool = options!.mediaTools!.find((candidate) => candidate.name === 'request_media')!;
      for (const [index, prompt] of ['', 'A blue skyline'].entries()) {
        const args = { operation: 'image.generate', prompt, artifactSlot: 'landing.hero' };
        const toolCallId = 'retry-' + index;
        options!.onToolEvent?.({ toolCallId, toolName: tool.name, status: 'running', args });
        const result = await tool.execute(toolCallId, args, options!.signal, undefined, {} as never);
        options!.onToolEvent?.({ toolCallId, toolName: tool.name, status: result.isError ? 'failed' : 'completed', details: result.details });
        expect(Boolean(result.isError)).toBe(index === 0);
      }
      onDelta('页面与配图已完成。');
      return { modelId: model.id, content: '页面与配图已完成。', inputTokens: 25, outputTokens: 9 };
    };
    const { core, requests } = await fixture({ invokeStreamed: invoke });
    const output = await core.run({ runId: 'recovered-dependency', sessionId: 'recovered-session', prompt: '开发一个产品页面并生成背景图', includeProjectContext: false });
    expect(output.stopReason).not.toBe('media_incomplete');
    expect(output.output).not.toContain('尚未完整交付');
    expect(output.artifacts).toHaveLength(1);
    expect(core.observability.getTrace('recovered-dependency')?.run.status).toBe('success');
    expect(requests).toHaveLength(1);
  });

  it('injects the media tool into a real Pi session and feeds the saved asset into the next text turn', async () => {
    const { core, requests, invocation } = await fixture({ sdk: true });
    const output = await core.run({ runId: 'sdk-media', sessionId: 'sdk-session', prompt: '开发一个产品页面并生成背景图', includeProjectContext: false });
    const textRequests = requests.filter((entry) => entry.path === '/v1/chat/completions');
    const imageRequests = requests.filter((entry) => entry.path === '/v1/images/generations');
    expect(invocation).not.toHaveBeenCalled();
    expect(textRequests).toHaveLength(2);
    expect(imageRequests).toHaveLength(1);
    expect(textRequests[0].body.tools.map((tool: any) => tool.function?.name)).toContain('request_media');
    const artifacts = output.artifacts as MediaArtifact[];
    expect(artifacts).toHaveLength(1);
    expect(textRequests[1].body.messages.some((message: any) => message.role === 'tool' && JSON.stringify(message.content).includes(artifacts[0].id))).toBe(true);
    expect(core.media.readAsset(artifacts[0].id).bytes).toEqual(Buffer.from(png, 'base64'));
    expect(output.output).toBe('页面与真实配图已完成。');
    expect(output.stopReason).not.toBe('media_incomplete');
  });
  it('routes a pure image request without a text call and saves actual bytes and trace identity', async () => {
    const { core, requests, events, invocation } = await fixture();
    const output = await core.run({ runId: 'direct-image', sessionId: 'direct-session', assistantMessageId: 'direct-assistant', prompt: '生成一张海边猫咪图片', includeProjectContext: false });
    const artifacts = output.artifacts as MediaArtifact[];
    expect(invocation).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: '/v1/images/generations', body: { model: 'image', prompt: '生成一张海边猫咪图片', n: 1, output_format: 'png' } });
    expect(artifacts).toHaveLength(1);
    expect(core.media.readAsset(artifacts[0].id).bytes).toEqual(Buffer.from(png, 'base64'));
    expect(core.media.listJobs('direct-image')[0]).toMatchObject({ sessionId: 'direct-session', assistantMessageId: 'direct-assistant', status: 'succeeded' });
    expect(core.observability.getTrace('direct-image')?.run.status).toBe('success');
    expect(core.observability.getTrace('direct-image')?.spans.find((span) => span.name === 'media.generate')?.attributes).toMatchObject({ modelSnapshot: { configurationId: 'image', modelId: 'image', operations: { 'image.generate': { protocol: 'openai-images' } } } });
    expect(events.filter((event) => event.channel === 'session:completed')).toHaveLength(1);
    expect(core.runningTasks.size).toBe(0);
  });

  it('lets automatically selected read-only collaborators request one shared image and includes it in final delivery', async () => {
    const childAssets: string[] = [];
    const invokedModels: string[] = [];
    const invoke: RunDependencies['invokeStreamed'] = async (model, prompt, _max, onDelta, options) => {
      invokedModels.push(model.id);
      if (options?.projectAccess === 'read') {
        expect(options.agentId).toBeTruthy();
        const tools = options.mediaTools!;
        expect(tools.map((tool) => tool.name)).toContain('request_media');
        expect(tools.map((tool) => tool.name)).not.toContain('materialize_asset');
        const tool = tools.find((candidate) => candidate.name === 'request_media')!;
        const result = await tool.execute('call-' + model.id, { operation: 'image.generate', prompt: 'A blue skyline with empty space on the left', artifactSlot: 'landing.hero', purpose: 'Landing page hero' }, options.signal, undefined, {} as never);
        expect(result.isError).not.toBe(true);
        const details = result.details as MediaResult;
        childAssets.push(details.artifacts[0].id);
        onDelta('The shared hero asset is ready.');
        return { modelId: model.id, content: 'The shared hero asset is ready.', inputTokens: 20, outputTokens: 8 };
      }
      expect(prompt).toContain('共享资产');
      expect(prompt).toContain(childAssets[0]);
      onDelta('页面与配图已完成。');
      return { modelId: model.id, content: '页面与配图已完成。', inputTokens: 25, outputTokens: 9 };
    };
    const { core, requests } = await fixture({ parallel: true, invokeStreamed: invoke, models: (baseURL) => [textModel('executor', baseURL), textModel('worker-a', baseURL, 1), textModel('worker-b', baseURL, 2), imageModel('lower-image', baseURL, 60), imageModel('better-image', baseURL, 95)] });
    const output = await core.run({ runId: 'compound-image', sessionId: 'compound-session', prompt: '开发一个产品页面并生成背景图', includeProjectContext: false });
    expect(invokedModels.sort()).toEqual(['executor', 'worker-a', 'worker-b']);
    expect(childAssets).toHaveLength(2);
    expect(new Set(childAssets).size).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.model).toBe('better-image');
    expect(output.artifacts).toEqual(core.media.listArtifacts('compound-image'));
    expect(output.artifacts).toHaveLength(1);
    expect(output.modelUsed).toMatchObject({ id: 'executor' });
    expect(output.metrics).toMatchObject({ totalCost: 0.03 });
    expect(core.media.listJobs('compound-image')).toHaveLength(1);
  });

  it('scopes a desktop text preference to text while a strict text override rejects direct media', async () => {
    const { core, requests, invocation } = await fixture();
    const result = await core.run({ runId: 'text-preference-image', prompt: '生成一张雪山图片', textModelPreferenceId: 'text', includeProjectContext: false });
    expect(result.modelUsed).toMatchObject({ id: 'image' });
    await expect(core.run({ runId: 'strict-text-image', prompt: '生成一张雪山图片', pinnedModelId: 'text', includeProjectContext: false })).rejects.toThrow('MODEL_OPERATION_MISMATCH');
    expect(requests).toHaveLength(1);
    expect(invocation).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown estimate', undefined, /预估费用/],
    ['over budget', 0.3, /成本预算/],
  ] as const)('rejects %s before sending a paid creation request', async (_name, estimate, message) => {
    const { core, requests } = await fixture({ models: (baseURL) => [imageModel('image', baseURL, 80, estimate)] });
    // Passing undefined as an argument uses the fixture default, so remove the estimate explicitly.
    if (estimate === undefined) core.registry.updateModel('image', { operations: { 'image.generate': { protocol: 'openai-images', score: 80 } } });
    await expect(core.run({ runId: 'budget-image', prompt: '生成一张海报', includeProjectContext: false })).rejects.toThrow(message);
    expect(requests).toEqual([]);
    expect(core.media.listArtifacts('budget-image')).toEqual([]);
    expect(core.observability.getTrace('budget-image')?.run.status).toBe('failed');
  });

  it('does not generate in plan-only mode and still returns a reviewable plan', async () => {
    const { core, requests, invocation } = await fixture();
    const output = await core.run({ runId: 'plan-only-image', sessionId: 'planned-image-session', prompt: '生成一张猫咪图片', planningMode: 'only', includeProjectContext: false });
    expect(output.stopReason).toBe('plan_only');
    expect(output.output).toContain('生成一张猫咪图片');
    expect(output.artifacts).toEqual([]);
    expect(core.media.listJobs()).toEqual([]);
    expect(requests).toEqual([]);
    expect(invocation).not.toHaveBeenCalled();
    expect(core.plans.latest('plan-only-image')).toMatchObject({ status: 'completed' });
  });
});
