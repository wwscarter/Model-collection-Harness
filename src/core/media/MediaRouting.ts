import { hasUsableCredentials, type ModelConfig } from '../models/ModelConfig';
import { getModelOperations, supportsOperation } from '../models/ModelOperations';
import { MediaError, type MediaRequest } from './MediaTypes';

export interface MediaCandidate { model: ModelConfig; request: MediaRequest; reason: string; estimatedCostUsd?: number; }
const sizesForRatio: Record<string, string> = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536', '16:9': '1536x864', '9:16': '864x1536' };
export function normalizeMediaRequest(input: MediaRequest): MediaRequest {
  if (!input || !['image.generate', 'video.generate'].includes(input.operation)) throw new MediaError('MEDIA_INVALID_REQUEST', '不支持的媒体操作');
  const allowed = ['operation', 'prompt', 'purpose', 'artifactSlot', 'revision', 'size', 'aspectRatio', 'format', 'transparentBackground', 'quality', 'durationSeconds', 'preference'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new MediaError('MEDIA_INVALID_REQUEST', '媒体请求包含不支持的字段');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000) throw new MediaError('MEDIA_INVALID_REQUEST', '媒体提示词须为 1–32000 个字符');
  if (input.purpose !== undefined && (typeof input.purpose !== 'string' || input.purpose.length > 2000)) throw new MediaError('MEDIA_INVALID_REQUEST', '媒体用途无效');
  if (input.artifactSlot !== undefined && (typeof input.artifactSlot !== 'string' || !/^[\w./:-]{1,160}$/.test(input.artifactSlot))) throw new MediaError('MEDIA_INVALID_REQUEST', '素材位置 ID 无效');
  if (input.revision !== undefined && (!Number.isInteger(input.revision) || input.revision < 0 || input.revision > 10000)) throw new MediaError('MEDIA_INVALID_REQUEST', '素材版本须为非负整数');
  if (input.size !== undefined && !/^\d{2,5}x\d{2,5}$/.test(input.size)) throw new MediaError('MEDIA_INVALID_REQUEST', '图片尺寸须为 WIDTHxHEIGHT');
  if (input.aspectRatio !== undefined && !/^\d{1,3}:\d{1,3}$/.test(input.aspectRatio)) throw new MediaError('MEDIA_INVALID_REQUEST', '图片比例无效');
  if (input.size) {
    const [width, height] = input.size.split('x').map(Number);
    if (!width || !height || width > 32768 || height > 32768 || width * height > 100_000_000) throw new MediaError('MEDIA_INVALID_REQUEST', '图片尺寸超出应用限制');
  }
  if (input.aspectRatio && input.aspectRatio.split(':').some((value) => Number(value) === 0)) throw new MediaError('MEDIA_INVALID_REQUEST', '图片比例无效');
  if (input.format !== undefined && !['png', 'jpeg', 'webp'].includes(input.format)) throw new MediaError('MEDIA_INVALID_REQUEST', '不支持的图片格式');
  if (input.quality !== undefined && !['auto', 'low', 'medium', 'high'].includes(input.quality)) throw new MediaError('MEDIA_INVALID_REQUEST', '图片质量无效');
  if (input.transparentBackground !== undefined && typeof input.transparentBackground !== 'boolean') throw new MediaError('MEDIA_INVALID_REQUEST', '透明背景须为布尔值');
  if (input.durationSeconds !== undefined && (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0)) throw new MediaError('MEDIA_INVALID_REQUEST', '视频时长无效');
  if (input.preference !== undefined && !['quality', 'cost', 'speed'].includes(input.preference)) throw new MediaError('MEDIA_INVALID_REQUEST', '路由偏好无效');
  if (input.operation === 'image.generate' && input.durationSeconds !== undefined) throw new MediaError('MEDIA_INVALID_REQUEST', '图片生成不接受视频时长');
  if (input.size && input.aspectRatio && !sizeRatioMatches(input.size, input.aspectRatio)) throw new MediaError('MEDIA_INVALID_REQUEST', '图片尺寸与比例冲突');
  return { ...input, prompt: input.prompt.trim(), revision: input.revision ?? 0 };
}
export function sizeRatioMatches(size: string, ratio: string): boolean {
  const [w, h] = size.split('x').map(Number); const [a, b] = ratio.split(':').map(Number);
  return !!(w && h && a && b) && Math.abs(w / h - a / b) < 0.01;
}
export function routeMediaRequest(input: MediaRequest, models: ModelConfig[]): MediaCandidate[] {
  const request = normalizeMediaRequest(input);
  const rejected: string[] = [];
  const result: MediaCandidate[] = [];
  for (const model of models) {
    if (!model.enabled || !hasUsableCredentials(model) || !supportsOperation(model, request.operation)) continue;
    const operation = getModelOperations(model)[request.operation];
    if (!operation || operation.protocol !== 'openai-images' || request.operation !== 'image.generate') continue;
    const limits = operation.limits;
    const reject = (why: string) => rejected.push(model.name + ': ' + why);
    if (request.transparentBackground && !limits?.transparentBackground) { reject('未声明透明背景能力'); continue; }
    if (request.aspectRatio && !limits?.sizes?.length) { reject('未声明可用尺寸，无法保证指定比例'); continue; }
    const preferredFormat = request.format ?? operation.defaults?.format;
    const format = preferredFormat ?? (limits?.formats?.includes('png') ? 'png' : limits?.formats?.[0] ?? 'png');
    if (limits?.formats?.length && !limits.formats.includes(format)) { reject('不支持指定格式'); continue; }
    if (request.format && !limits?.formats?.includes(request.format) && operation.defaults?.format !== request.format) { reject('未声明指定格式能力'); continue; }
    const quality = request.quality ?? operation.defaults?.quality;
    if (request.quality && !limits?.qualities?.includes(request.quality) && operation.defaults?.quality !== request.quality) { reject('未声明指定质量能力'); continue; }
    if (request.transparentBackground && format === 'jpeg') { reject('JPEG 不支持透明背景'); continue; }
    let size = request.size;
    if (!size && request.aspectRatio) size = limits?.sizes?.find((value) => sizeRatioMatches(value, request.aspectRatio!));
    if (!size && request.aspectRatio) { reject('没有满足指定比例的已声明尺寸'); continue; }
    size ??= operation.defaults?.size;
    if (size && limits?.sizes?.length && !limits.sizes.includes(size)) { reject('不支持指定尺寸或比例'); continue; }
    if (request.size && !limits?.sizes?.includes(request.size) && operation.defaults?.size !== request.size) { reject('未声明指定尺寸能力'); continue; }
    const normalized = { ...request, size, format, quality };
    result.push({ model, request: normalized, estimatedCostUsd: operation.estimatedCostUsd, reason: '操作 ' + request.operation + '、协议 ' + operation.protocol + ' 与全部硬约束匹配；按 ' + (request.preference ?? 'quality') + ' 偏好排序' });
  }
  const op = (candidate: MediaCandidate) => getModelOperations(candidate.model)[request.operation]!;
  result.sort((a, b) => {
    const left = op(a), right = op(b);
    if (request.preference === 'cost') {
      if (left.estimatedCostUsd !== undefined && right.estimatedCostUsd !== undefined && left.estimatedCostUsd !== right.estimatedCostUsd) return left.estimatedCostUsd - right.estimatedCostUsd;
      if (left.estimatedCostUsd !== undefined && right.estimatedCostUsd === undefined) return -1;
      if (left.estimatedCostUsd === undefined && right.estimatedCostUsd !== undefined) return 1;
    }
    if (request.preference === 'speed') {
      if (left.expectedDurationMs !== undefined && right.expectedDurationMs !== undefined && left.expectedDurationMs !== right.expectedDurationMs) return left.expectedDurationMs - right.expectedDurationMs;
      if (left.expectedDurationMs !== undefined && right.expectedDurationMs === undefined) return -1;
      if (left.expectedDurationMs === undefined && right.expectedDurationMs !== undefined) return 1;
    }
    return (right.score ?? 50) - (left.score ?? 50) || a.model.priority - b.model.priority || a.model.id.localeCompare(b.model.id);
  });
  if (!result.length) throw new MediaError('MEDIA_MODEL_UNAVAILABLE', request.operation === 'video.generate' ? '尚未接入可执行的视频生成协议，请配置后续支持的视频适配器' : '没有满足本次图片生成要求的可用模型' + (rejected.length ? '：' + rejected.join('；') : ''), { rejected });
  return result;
}
