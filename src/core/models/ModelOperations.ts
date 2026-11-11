/** Operations are executable capabilities; task scores alone never grant them. */
export type ModelOperation = 'text.chat' | 'image.generate' | 'video.generate';
export type OperationProtocol = 'text' | 'openai-images' | 'unconfigured';

export interface OperationConfig {
  protocol: OperationProtocol;
  score?: number;
  estimatedCostUsd?: number;
  expectedDurationMs?: number;
  /** Legacy metadata retained for configuration compatibility; it does not gate image routing. */
  limits?: { sizes?: string[]; formats?: string[]; qualities?: string[]; transparentBackground?: boolean; maxDurationSeconds?: number };
  /** Provider-defined generation values are forwarded without a local capability whitelist. */
  defaults?: { size?: string; quality?: string; format?: string };
  pricing?: { inputTextPerMillion?: number; inputImagePerMillion?: number; outputImagePerMillion?: number };
}
export type ModelOperations = Partial<Record<ModelOperation, OperationConfig>>;
type OperationsModel = { operations?: ModelOperations };
const OPERATIONS: ModelOperation[] = ['text.chat', 'image.generate', 'video.generate'];

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
      strings(limits.formats, '输出格式');
      strings(limits.qualities, '图片质量');
      if (limits.transparentBackground !== undefined && typeof limits.transparentBackground !== 'boolean') throw new Error('透明背景支持须为布尔值');
      number(limits.maxDurationSeconds, '视频时长上限', 1);
    }
    if (config.defaults !== undefined) {
      const defaults = object(config.defaults, ['size', 'quality', 'format'], '操作默认参数');
      string(defaults.size, '默认尺寸');
      string(defaults.quality, '默认质量');
      string(defaults.format, '默认格式');
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
function string(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 100)) throw new Error(label + '无效');
}
function strings(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 100) || new Set(value).size !== value.length) throw new Error(label + '列表无效');
}
