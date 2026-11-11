import { protocol } from 'electron';
import type { MediaExecutionService } from '@core/media/MediaExecutionService';

/** Opaque app assets only; neither the renderer nor a URL can select filesystem paths. */
export function mediaAssetId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'newai-media:' || parsed.hostname !== 'asset' || parsed.search || parsed.hash) return;
    const id = parsed.pathname.slice(1);
    return /^[a-zA-Z0-9-]{1,100}$/.test(id) ? id : undefined;
  } catch { return; }
}

export function registerMediaProtocol(media: MediaExecutionService): void {
  protocol.handle('newai-media', async (request) => {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const id = mediaAssetId(request.url);
    if (!id) return new Response(null, { status: 400 });
    try {
      const { artifact, bytes } = await media.readAsset(id);
      return new Response(new Uint8Array(bytes), { headers: {
        'Content-Type': artifact.mimeType, 'Content-Length': String(bytes.length),
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600',
      } });
    } catch { return new Response(null, { status: 404 }); }
  });
}
