import type { ModelConfig } from '../../models/ModelConfig';
import { MediaError, type GeneratedImage, type MediaRequest } from '../MediaTypes';

export class ImageProviderError extends MediaError {
  constructor(message: string, readonly safeToRetry: boolean) { super(safeToRetry ? 'MEDIA_PROVIDER_REJECTED' : 'MEDIA_RESULT_UNKNOWN', message); }
}
export function resolveImagesEndpoint(baseURL?: string): string {
  let url: URL;
  try { url = new URL(baseURL?.trim() || 'https://api.openai.com/v1'); } catch { throw new MediaError('MEDIA_INVALID_ENDPOINT', '图片接口地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new MediaError('MEDIA_INVALID_ENDPOINT', '图片接口地址无效');
  let pathname = url.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$|\/responses$/.test(pathname)) throw new MediaError('MEDIA_INVALID_ENDPOINT', '图片模型请填写服务根地址或 images/generations 接口，不要填写文本接口');
  if (!pathname.endsWith('/images/generations')) pathname += '/images/generations';
  url.pathname = pathname; url.hash = '';
  return url.toString();
}
function dimensions(bytes: Buffer): { mimeType: string; extension: 'png' | 'jpeg' | 'webp'; width: number; height: number } {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    let offset = 8, hasData = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset); const end = offset + 12 + length;
      if (end > bytes.length) break;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'IDAT') hasData = true;
      if (type === 'IEND') { ended = end === bytes.length; break; }
      offset = end;
    }
    if (!hasData || !ended) throw new ImageProviderError('图片响应中的 PNG 文件不完整', false);
    return { mimeType: 'image/png', extension: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xff) { offset += 1; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) return { mimeType: 'image/jpeg', extension: 'jpeg', width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    const type = bytes.toString('ascii', 12, 16);
    if (type === 'VP8X') return { mimeType: 'image/webp', extension: 'webp', width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    if (type === 'VP8L' && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); return { mimeType: 'image/webp', extension: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
    if (type === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { mimeType: 'image/webp', extension: 'webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  throw new ImageProviderError('图片响应不是受支持的完整 PNG、JPEG 或 WebP 文件', false);
}
export function decodeGeneratedImage(encoded: unknown): GeneratedImage {
  if (typeof encoded !== 'string' || !encoded || encoded.length > 48 * 1024 * 1024 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) throw new ImageProviderError('图片响应缺少有效的 Base64 图片数据', false);
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > 32 * 1024 * 1024 || bytes.toString('base64') !== encoded) throw new ImageProviderError('图片文件超出限制或 Base64 编码无效', false);
  const meta = dimensions(bytes);
  if (meta.width <= 0 || meta.height <= 0 || meta.width > 32768 || meta.height > 32768 || meta.width * meta.height > 100_000_000) throw new ImageProviderError('图片尺寸超出应用限制', false);
  return { bytes, ...meta };
}
export interface ImageGenerationResult { images: GeneratedImage[]; usage?: unknown; }
function normalizeUsage(value: any): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const count = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : undefined;
  return { input_tokens: count(value.input_tokens), output_tokens: count(value.output_tokens), total_tokens: count(value.total_tokens),
    input_tokens_details: { text_tokens: count(value.input_tokens_details?.text_tokens), image_tokens: count(value.input_tokens_details?.image_tokens) },
    output_tokens_details: { text_tokens: count(value.output_tokens_details?.text_tokens), image_tokens: count(value.output_tokens_details?.image_tokens) },
  };
}
async function boundedJson(response: Response): Promise<any> {
  if (!response.body) throw new ImageProviderError('图片接口响应为空', false);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 48 * 1024 * 1024) { await reader.cancel(); throw new ImageProviderError('图片响应超过 48 MiB 限制', false); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ImageProviderError('图片接口未返回有效 JSON；生成状态未知', false); }
}
function imagePrompt(request: MediaRequest): string {
  const requirements = [
    ...(request.aspectRatio ? ['Requested aspect ratio: ' + request.aspectRatio + '.'] : []),
    ...(request.minSize ? ['Requested minimum image dimensions (width x height): ' + request.minSize + '.'] : []),
  ];
  return requirements.length ? request.prompt + '\n\nImage output requirements:\n' + requirements.join('\n') : request.prompt;
}
function providerErrorReason(value: unknown, model: ModelConfig): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const detail = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : record;
  const message = typeof detail.message === 'string' ? detail.message : undefined;
  const code = typeof detail.code === 'string' || typeof detail.code === 'number' ? String(detail.code) : undefined;
  if (!message && !code) return undefined;
  const secrets = [model.apiKey];
  try {
    for (const [key, secret] of new URL(model.baseURL ?? '').searchParams) {
      if (/^(?:api[_-]?key|key|access[_-]?token|token|auth(?:orization)?|password|client[_-]?secret|signature)$/i.test(key)) secrets.push(secret);
    }
  } catch { /* Endpoint validation reports malformed addresses separately. */ }
  let reason = [code, message].filter(Boolean).join(' — ');
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    for (const encoded of new Set([secret, encodeURIComponent(secret)])) reason = reason.split(encoded).join('[redacted]');
  }
  return reason.replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}
async function readProviderError(response: Response, model: ModelConfig): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const timedOut = Symbol('error-body-timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), 2_000); });
  // An error detail is optional: a stalled body or cancellation must not hide the known HTTP rejection.
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next === timedOut) { cancel(); return undefined; }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16 * 1024) { cancel(); return undefined; }
      chunks.push(next.value);
    }
    return providerErrorReason(JSON.parse(Buffer.concat(chunks).toString('utf8')), model);
  } catch { return undefined; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}
export class OpenAIImagesProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async generate(model: ModelConfig, request: MediaRequest, signal?: AbortSignal): Promise<ImageGenerationResult> {
    const endpoint = resolveImagesEndpoint(model.baseURL);
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetcher(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(model.apiKey ? { authorization: 'Bearer ' + model.apiKey } : {}) }, signal,
        body: JSON.stringify({ model: model.modelId, prompt: imagePrompt(request), n: 1, ...(request.format ? { output_format: request.format } : {}), ...(request.size ? { size: request.size } : {}), ...(request.quality ? { quality: request.quality } : {}), ...(request.transparentBackground !== undefined ? { background: request.transparentBackground ? 'transparent' : 'opaque' } : {}) }),
      });
    } catch (error) { throw new ImageProviderError(signal?.aborted ? '图片请求已停止；上游是否生成尚未知，不能自动重新提交' : '图片提交连接中断；上游接受状态未知，请勿自动重新提交', false); }
    if (!response.ok) {
      // These statuses explicitly reject the creation request; 5xx can follow acceptance at a gateway.
      const safe = [400, 401, 403, 404, 422, 429].includes(response.status);
      const reason = await readProviderError(response, model);
      throw new ImageProviderError('图片生成接口返回 HTTP ' + response.status + (reason ? '：' + reason : ''), safe);
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > 48 * 1024 * 1024) throw new ImageProviderError('图片响应过大', false);
    const data = await boundedJson(response);
    if (data?.error) {
      const reason = providerErrorReason(data, model);
      throw new ImageProviderError('图片接口返回错误，生成状态需确认' + (reason ? '：' + reason : ''), false);
    }
    if (!Array.isArray(data?.data) || data.data.length !== 1) throw new ImageProviderError('图片接口未按一次一张的请求返回图片数据，不能以文字代替成功结果', false);
    const images = data.data.map((item: any) => decodeGeneratedImage(item?.b64_json)) as GeneratedImage[];
    return { images, usage: normalizeUsage(data.usage) };
  }
}
