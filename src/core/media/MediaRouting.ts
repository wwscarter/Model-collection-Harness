import { hasUsableCredentials, type ModelConfig } from '../models/ModelConfig';
import { getModelOperations, supportsOperation } from '../models/ModelOperations';
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
  // Bound transport fields, but let the endpoint decide supported values and combinations.
  for (const key of ['size', 'minSize', 'aspectRatio', 'format', 'quality'] as const) {
    const value = input[key];
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)))
      throw new MediaError('MEDIA_INVALID_REQUEST', '图片参数 ' + key + ' 须为 1–100 个字符的文本');
  }
  if (input.transparentBackground !== undefined && typeof input.transparentBackground !== 'boolean') throw new MediaError('MEDIA_INVALID_REQUEST', '透明背景须为布尔值');
  if (input.durationSeconds !== undefined && (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0)) throw new MediaError('MEDIA_INVALID_REQUEST', '视频时长无效');
  if (input.preference !== undefined && !['quality', 'cost', 'speed'].includes(input.preference)) throw new MediaError('MEDIA_INVALID_REQUEST', '路由偏好无效');
  if (input.operation === 'image.generate' && input.durationSeconds !== undefined) throw new MediaError('MEDIA_INVALID_REQUEST', '图片生成不接受视频时长');
  return { ...input, prompt: input.prompt.trim(), revision: input.revision ?? 0 };
}

export function routeMediaRequest(input: MediaRequest, models: ModelConfig[]): MediaCandidate[] {
  const request = normalizeMediaRequest(input);
  const result: MediaCandidate[] = [];
  for (const model of models) {
    if (!model.enabled || !hasUsableCredentials(model) || !supportsOperation(model, request.operation)) continue;
    const operation = getModelOperations(model)[request.operation];
    if (!operation || operation.protocol !== 'openai-images' || request.operation !== 'image.generate') continue;
    // Historical limits are metadata only. Provider responses determine actual capabilities.
    const normalized = { ...request, size: request.size ?? operation.defaults?.size,
      format: request.format ?? operation.defaults?.format, quality: request.quality ?? operation.defaults?.quality };
    result.push({ model, request: normalized, estimatedCostUsd: operation.estimatedCostUsd,
      reason: '操作 ' + request.operation + ' 与协议 ' + operation.protocol + ' 可执行；生成参数由模型和服务端处理；按 ' + (request.preference ?? 'quality') + ' 偏好排序' });
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
  if (!result.length) throw new MediaError('MEDIA_MODEL_UNAVAILABLE', request.operation === 'video.generate' ? '尚未接入可执行的视频生成协议，请配置后续支持的视频适配器' : '没有启用且配置可执行图片协议的可用模型');
  return result;
}
