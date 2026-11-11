import { describe, expect, it, vi } from 'vitest';
import { restoreSessionMedia } from '../../src/main/mediaSession';
import { mediaAssetId, registerMediaProtocol } from '../../src/main/mediaProtocol';
import type { MediaExecutionService } from '../../src/core/media/MediaExecutionService';

const state = vi.hoisted(() => ({ handler: undefined as ((request: Request) => Promise<Response>) | undefined }));
vi.mock('electron', () => ({ protocol: { handle: (_name: string, handler: typeof state.handler) => { state.handler = handler; } } }));

describe('media host boundaries', () => {
  it('serves only registered opaque asset ids and never resolves arbitrary file URLs', async () => {
    expect(mediaAssetId('newai-media://asset/asset-1')).toBe('asset-1');
    for (const url of ['file:///etc/passwd', 'newai-media://other/asset-1', 'newai-media://asset/a/b', 'newai-media://asset/%2e%2e%2fsecret', 'newai-media://asset/asset-1?path=/secret']) expect(mediaAssetId(url)).toBeUndefined();
    const readAsset = vi.fn((id) => { if (id !== 'asset-1') throw new Error('missing'); return { artifact: { mimeType: 'image/png' }, bytes: Buffer.from([1, 2, 3]) }; });
    registerMediaProtocol({ readAsset } as unknown as MediaExecutionService);
    const response = await state.handler!(new Request('newai-media://asset/asset-1'));
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    expect((await state.handler!(new Request('newai-media://asset/missing'))).status).toBe(404);
    expect((await state.handler!(new Request('newai-media://asset/a/b'))).status).toBe(400);
    expect(readAsset).toHaveBeenCalledTimes(2);
  });

  it('restores paid results from durable jobs when a renderer saved stale messages', () => {
    const artifact = { id: 'a', kind: 'image' as const, mimeType: 'image/png', fileName: 'a.png', configurationId: 'image', modelId: 'image', jobId: 'job' };
    const media = { listJobs: () => [
      { id: 'job', sessionId: 'session', rootRunId: 'run', assistantMessageId: 'answer', operation: 'image.generate', status: 'succeeded', artifacts: [artifact] },
      { id: 'foreign', sessionId: 'other', rootRunId: 'run', assistantMessageId: 'foreign', operation: 'image.generate', status: 'unknown', artifacts: [] },
    ] } as unknown as MediaExecutionService;
    const restored = restoreSessionMedia({ id: 'session', title: 't', prompt: 'image', output: '', messages: [{ id: 'answer', role: 'assistant', content: '' }], createdAt: new Date(), updatedAt: new Date() }, media)!;
    expect(restored.messages).toHaveLength(1);
    expect(restored.messages![0].artifacts).toEqual([artifact]);
    expect(restored.messages![0].mediaJobs).toEqual([expect.objectContaining({ id: 'job', status: 'succeeded' })]);
    expect(restoreSessionMedia(restored, media)).toEqual(restored);
  });
});
