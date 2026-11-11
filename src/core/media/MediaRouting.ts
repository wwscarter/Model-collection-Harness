import { hasUsableCredentials, type ModelConfig } from '../models/ModelConfig';
import { getModelOperations, supportsOperation } from '../models/ModelOperations';
import { extractExplicitMediaConstraints } from '../routing/RequestOperation';
import { MediaError, type MediaRequest } from './MediaTypes';

export interface MediaCandidate { model: ModelConfig; request: MediaRequest; reason: string; estimatedCostUsd?: number; }
export function normalizeMediaRequest(input: MediaRequest): MediaRequest {
  if (!input || !['image.generate', 'video.generate'].includes(input.operation)) throw new MediaError('MEDIA_INVALID_REQUEST', '不支持的媒体操作');
  const allowed = ['operation', 'prompt', 'purpose', 'artifactSlot', 'revision', 'size', 'minSize', 'aspectRatio', 'format', 'transparentBackground', 'quality', 'durationSeconds', 'preference'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new MediaError('MEDIA_INVALID_REQUEST', '媒体请求包含不支持的字段');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000) throw new MediaError('MEDIA_INVALID_REQUEST', '媒体提示词须为 1–32000 个字符');
  if (input.purpose !== undefined && (typeof input.purpose !== 'string' || input.purpose.length > 2000)) throw new MediaError('MEDIA_INVALID_REQUEST', '媒体用途无效');
  if (input.artifactSlot !== undefined && (typeof input.artifactSlot !== 'string' || !/^[\w./:-]{1,160}$/.test(input.artifactSlot))) throw new MediaError('MEDIA_INVALID_REQUEST', '素材位置 ID 无效');
  if (input.revision !== undefined && (!Number.isInteger(input.revision) || input.revision < 0 || input.revision > 10000)) throw new MediaError('MEDIA_INVALID_REQUEST', '素材版本须为非负整数');
  if (input.aspectRatio !== undefined && !/^\d{1,3}:\d{1,3}$/.test(input.aspectRatio)) throw new MediaError('MEDIA_INVALID_REQUEST', '图片比例无效');
  for (const size of [input.size, input.minSize]) {
    if (size === undefined) continue;
    if (typeof size !== 'string' || !/^\d{2,5}x\d{2,5}$/.test(size)) throw new MediaError('MEDIA_INVALID_REQUEST', '图片尺寸须为 WIDTHxHEIGHT');
    const [width, height] = size.split('x').map(Number);
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
  if (input.size && input.minSize && !sizeAtLeast(input.size, input.minSize)) throw new MediaError('MEDIA_INVALID_REQUEST', '精确图片尺寸小于要求的最小尺寸');
  return { ...input, prompt: input.prompt.trim(), revision: input.revision ?? 0 };
}

/** Both direct runs and agent tools retain explicit requirements written in the prompt. */
export function resolveMediaRequest(input: MediaRequest): MediaRequest {
  const request = normalizeMediaRequest(input);
  let inferred: ReturnType<typeof extractExplicitMediaConstraints>;
  try { inferred = extractExplicitMediaConstraints(request.prompt); }
  catch (error) { throw new MediaError('MEDIA_INVALID_REQUEST', error instanceof Error ? error.message : String(error)); }
  if (request.operation === 'image.generate') delete inferred.durationSeconds;
  for (const key of ['size', 'minSize', 'aspectRatio', 'format', 'transparentBackground', 'durationSeconds'] as const) {
    const fromPrompt = inferred[key], fromParameter = request[key];
    if (fromPrompt !== undefined && fromParameter !== undefined && fromPrompt !== fromParameter)
      throw new MediaError('MEDIA_CONSTRAINT_CONFLICT', 'MEDIA_CONSTRAINT_CONFLICT：文字要求与显式媒体参数中的 ' + key + ' 不一致');
    if (fromPrompt !== undefined) Object.assign(request, { [key]: fromPrompt });
  }
  return normalizeMediaRequest(request);
}
export function sizeRatioMatches(size: string, ratio: string): boolean {
  const [w, h] = size.split('x').map(Number); const [a, b] = ratio.split(':').map(Number);
  return !!(w && h && a && b) && Math.abs(w / h - a / b) < 0.01;
}
function dimensions(size: string): [number, number] {
  return size.split('x').map(Number) as [number, number];
}
export function sizeAtLeast(candidate: string, target: string): boolean {
  const [candidateWidth, candidateHeight] = dimensions(candidate);
  const [targetWidth, targetHeight] = dimensions(target);
  return candidateWidth >= targetWidth && candidateHeight >= targetHeight;
}
function smallestSize(candidates: string[]): string | undefined {
  return [...candidates].sort((left, right) => {
    const [leftWidth, leftHeight] = dimensions(left); const [rightWidth, rightHeight] = dimensions(right);
    return leftWidth * leftHeight - rightWidth * rightHeight || leftWidth - rightWidth || leftHeight - rightHeight;
  })[0];
}
export function routeMediaRequest(input: MediaRequest, models: ModelConfig[]): MediaCandidate[] {
  const request = resolveMediaRequest(input);
  const rejected: string[] = [];
  const result: MediaCandidate[] = [];
  for (const model of models) {
    if (!model.enabled || !hasUsableCredentials(model) || !supportsOperation(model, request.operation)) continue;
    const operation = getModelOperations(model)[request.operation];
    if (!operation || operation.protocol !== 'openai-images' || request.operation !== 'image.generate') continue;
    const limits = operation.limits;
    const reject = (why: string) => rejected.push(model.name + ': ' + why);
    if (request.transparentBackground && !limits?.transparentBackground) { reject('未声明透明背景能力'); continue; }
    const preferredFormat = request.format ?? operation.defaults?.format;
    const format = preferredFormat ?? (limits?.formats?.includes('png') ? 'png' : limits?.formats?.[0] ?? 'png');
    if (limits?.formats?.length && !limits.formats.includes(format)) { reject('不支持指定格式'); continue; }
    if (request.format && !limits?.formats?.includes(request.format) && operation.defaults?.format !== request.format) { reject('未声明指定格式能力'); continue; }
    const quality = request.quality ?? operation.defaults?.quality;
    if (request.quality && !limits?.qualities?.includes(request.quality) && operation.defaults?.quality !== request.quality) { reject('未声明指定质量能力'); continue; }
    if (request.transparentBackground && format === 'jpeg') { reject('JPEG 不支持透明背景'); continue; }
    let size = request.size;
    if (request.size || request.minSize || request.aspectRatio) {
      const declaredSizes = limits?.sizes?.length ? limits.sizes : operation.defaults?.size ? [operation.defaults.size] : [];
      if (!declaredSizes.length) {
        const reason = request.size ? '未声明指定尺寸能力（' + request.size + '）' : request.minSize ? '未声明可用尺寸，无法保证最小尺寸 ' + request.minSize : '未声明可用尺寸，无法保证指定比例 ' + request.aspectRatio;
        reject(reason + '；请在“模型与端点 → 图片生成 → 支持的尺寸”填写端点实际支持的尺寸，不能通过删除约束解决');
        continue;
      }
      if (request.size) {
        if (!declaredSizes.includes(request.size)) { reject('不支持指定精确尺寸 ' + request.size + '；已声明：' + declaredSizes.join(', ')); continue; }
      } else {
        const ratioMatches = request.aspectRatio ? declaredSizes.filter((value) => sizeRatioMatches(value, request.aspectRatio!)) : declaredSizes;
        if (!ratioMatches.length) { reject('没有满足指定比例 ' + request.aspectRatio + ' 的已声明尺寸'); continue; }
        if (request.minSize) {
          size = smallestSize(ratioMatches.filter((value) => sizeAtLeast(value, request.minSize!)));
          if (!size) { reject('没有不小于目标尺寸 ' + request.minSize + ' 的已声明尺寸；已声明：' + declaredSizes.join(', ')); continue; }
        } else {
          size = ratioMatches[0];
        }
      }
    }
    size ??= operation.defaults?.size;
    if (size && limits?.sizes?.length && !limits.sizes.includes(size)) { reject('不支持指定尺寸或比例'); continue; }
    const normalized = { ...request, size, format, quality };
    const sizeNote = request.minSize && size ? '；尺寸选择为不小于目标的最近档位 ' + size + '（下限 ' + request.minSize + '）' : '';
    result.push({ model, request: normalized, estimatedCostUsd: operation.estimatedCostUsd, reason: '操作 ' + request.operation + '、协议 ' + operation.protocol + ' 与全部硬约束匹配；按 ' + (request.preference ?? 'quality') + ' 偏好排序' + sizeNote });
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
