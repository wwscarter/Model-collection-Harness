/** Operations are executable capabilities; task scores alone never grant them. */
export type ModelOperation = 'text.chat' | 'image.generate' | 'video.generate';
export type OperationProtocol = 'text' | 'openai-images' | 'unconfigured';
export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type ImageQuality = 'auto' | 'low' | 'medium' | 'high';

export interface OperationConfig {
  protocol: OperationProtocol;
  score?: number;
  estimatedCostUsd?: number;
  expectedDurationMs?: number;
  limits?: { sizes?: string[]; formats?: ImageFormat[]; qualities?: ImageQuality[]; transparentBackground?: boolean; maxDurationSeconds?: number };
  defaults?: { size?: string; quality?: ImageQuality; format?: ImageFormat };
  pricing?: { inputTextPerMillion?: number; inputImagePerMillion?: number; outputImagePerMillion?: number };
}
export type ModelOperations = Partial<Record<ModelOperation, OperationConfig>>;
type OperationsModel = { operations?: ModelOperations };
const OPERATIONS: ModelOperation[] = ['text.chat', 'image.generate', 'video.generate'];
const FORMATS: ImageFormat[] = ['png', 'jpeg', 'webp'];

/** Missing metadata is the legacy text contract. Explicit metadata never adds text implicitly. */
export function getModelOperations(model: OperationsModel): ModelOperations {
  return model.operations ?? { 'text.chat': { protocol: 'text' } };
}

/** Intersect declared capability with implemented protocol capability. */
export function supportsOperation(model: OperationsModel, operation: ModelOperation): boolean {
  const configured = getModelOperations(model)[operation];
  return Boolean(configured && ((operation === 'text.chat' && configured.protocol === 'text')
    || (operation === 'image.generate' && configured.protocol === 'openai-images')));
}

export function cloneModelOperations(operations: ModelOperations | undefined): ModelOperations | undefined {
  return operations === undefined ? undefined : structuredClone(operations);
}

export function validateModelOperations(value: unknown): asserts value is ModelOperations | undefined {
  if (value === undefined) return;
  const record = object(value, OPERATIONS, '模型操作');
  if (!Object.keys(record).length) throw new Error('至少配置一种模型操作');
  for (const [operation, raw] of Object.entries(record)) {
    const config = object(raw, ['protocol', 'score', 'estimatedCostUsd', 'expectedDurationMs', 'limits', 'defaults', 'pricing'], operation);
    const protocol = config.protocol;
    if (!['text', 'openai-images', 'unconfigured'].includes(String(protocol))) throw new Error(operation + ' 的协议无效');
    if (protocol !== 'unconfigured' && !((operation === 'text.chat' && protocol === 'text') || (operation === 'image.generate' && protocol === 'openai-images'))) throw new Error(operation + ' 与协议不兼容');
    number(config.score, '操作评分', 0, 100);
    number(config.estimatedCostUsd, '预估费用', 0);
    number(config.expectedDurationMs, '预估耗时', 1);
    if (config.limits !== undefined) {
      const limits = object(config.limits, ['sizes', 'formats', 'qualities', 'transparentBackground', 'maxDurationSeconds'], '操作限制');
      strings(limits.sizes, '尺寸');
      if (Array.isArray(limits.sizes) && !limits.sizes.every(validImageSize)) throw new Error('尺寸列表须为有效的 WIDTHxHEIGHT');
      strings(limits.formats, '输出格式', FORMATS);
      strings(limits.qualities, '图片质量', ['auto', 'low', 'medium', 'high']);
      if (limits.transparentBackground !== undefined && typeof limits.transparentBackground !== 'boolean') throw new Error('透明背景支持须为布尔值');
      number(limits.maxDurationSeconds, '视频时长上限', 1);
    }
    if (config.defaults !== undefined) {
      const defaults = object(config.defaults, ['size', 'quality', 'format'], '操作默认参数');
      if (defaults.size !== undefined && !validImageSize(defaults.size)) throw new Error('默认尺寸须为有效的 WIDTHxHEIGHT');
      if (defaults.quality !== undefined && !['auto', 'low', 'medium', 'high'].includes(String(defaults.quality))) throw new Error('默认质量无效');
      if (defaults.format !== undefined && !FORMATS.includes(defaults.format as ImageFormat)) throw new Error('默认格式无效');
      const limits = config.limits as OperationConfig['limits'];
      if (defaults.size !== undefined && limits?.sizes && !limits.sizes.includes(defaults.size as string)) throw new Error('默认尺寸超出操作限制');
      if (defaults.format !== undefined && limits?.formats && !limits.formats.includes(defaults.format as ImageFormat)) throw new Error('默认格式超出操作限制');
      if (defaults.quality !== undefined && limits?.qualities && !limits.qualities.includes(defaults.quality as ImageQuality)) throw new Error('默认质量超出操作限制');
    }
    if (config.pricing !== undefined) {
      const pricing = object(config.pricing, ['inputTextPerMillion', 'inputImagePerMillion', 'outputImagePerMillion'], '媒体费率');
      for (const [key, rate] of Object.entries(pricing)) number(rate, key, 0);
    }
  }
}

function object(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '须为对象');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(label + '包含未知字段');
  return record;
}
function number(value: unknown, label: string, min: number, max = Number.MAX_VALUE): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)) throw new Error(label + '无效');
}
function validImageSize(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(value)) return false;
  const [width, height] = value.split('x').map(Number);
  return width <= 32768 && height <= 32768 && width * height <= 100_000_000;
}
function strings(value: unknown, label: string, allowed?: readonly string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 100 || (allowed && !allowed.includes(item))) || new Set(value).size !== value.length) throw new Error(label + '列表无效');
}
