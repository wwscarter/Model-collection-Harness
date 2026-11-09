import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface RoutingSettings {
  version: 1;
  legacyProviders?: boolean;
  classifier: {
    mode: 'rules' | 'ollama';
    baseURL: string;
    model: string;
    timeoutMs: number;
    promptVersion: 'v3';
  };
  planning: { mode: 'auto' | 'off'; modelId?: string; executionMode?: 'auto' | 'confirm' | 'only' };
  utilityModelId?: string;
  budget?: { maxCostUsd: number; maxDurationMs: number };
}

export const DEFAULT_ROUTING_SETTINGS: RoutingSettings = {
  version: 1,
  legacyProviders: false,
  classifier: { mode: 'rules', baseURL: 'http://127.0.0.1:11434', model: 'qwen3:1.7b', timeoutMs: 3000, promptVersion: 'v3' },
  planning: { mode: 'auto', executionMode: 'auto' },
  budget: { maxCostUsd: 0.25, maxDurationMs: 600_000 },
};

function object(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '必须是对象');
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(label + '包含未知字段「' + unknown + '」');
  return record;
}

function text(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(label + '须为 1–' + maximum + ' 字符的文本');
  return value.trim();
}

/** Classifier traffic stays on loopback; execution-model endpoints are separate. */
export function validateRoutingBaseURL(value: unknown): string {
  const input = text(value, 'Ollama 地址', 2048);
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Ollama 地址无效'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || !loopback) throw new Error('Ollama 分类仅支持本机 loopback HTTP/HTTPS 地址');
  if (url.username || url.password || input.includes('@') || url.search || url.hash || url.pathname !== '/' || !/^https?:\/\/[^/?#\\]+\/?$/i.test(input)) throw new Error('Ollama 地址不能包含凭据、路径、查询或片段，请使用服务根地址');
  return url.origin;
}

export function validateRoutingModel(value: unknown): string {
  const model = text(value, 'Ollama 模型');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model) || /(?:^|[-:/_.])cloud(?:$|[-:/_.])/i.test(model)) throw new Error('请选择有效的本地 Ollama 模型，不能使用 cloud 模型');
  return model;
}

export function validateRoutingSettings(value: unknown): RoutingSettings {
  const root = object(value, ['version', 'legacyProviders', 'classifier', 'planning', 'utilityModelId', 'budget'], '路由设置');
  if (root.version !== 1) throw new Error('不支持的路由设置版本');
  if (root.legacyProviders !== undefined && typeof root.legacyProviders !== 'boolean') throw new Error('旧版模型适配器开关须为布尔值');
  const classifier = object(root.classifier, ['mode', 'baseURL', 'model', 'timeoutMs', 'promptVersion'], '分类设置');
  if (classifier.mode !== 'rules' && classifier.mode !== 'ollama') throw new Error('分类模式须为 rules 或 ollama');
  if (classifier.promptVersion !== 'v3') throw new Error('分类提示词版本须为 v3');
  if (!Number.isSafeInteger(classifier.timeoutMs) || (classifier.timeoutMs as number) < 250 || (classifier.timeoutMs as number) > 30_000) throw new Error('分类超时须为 250–30000 毫秒的整数');
  const planning = object(root.planning, ['mode', 'modelId', 'executionMode'], '规划设置');
  if (planning.mode !== 'auto' && planning.mode !== 'off') throw new Error('规划模式须为 auto 或 off');
  if (planning.executionMode !== undefined && !['auto', 'confirm', 'only'].includes(planning.executionMode as string)) throw new Error('计划执行模式须为 auto、confirm 或 only');
  const budget = root.budget === undefined ? DEFAULT_ROUTING_SETTINGS.budget! : object(root.budget, ['maxCostUsd', 'maxDurationMs'], '运行预算');
  if (typeof budget.maxCostUsd !== 'number' || !Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd < 0.01 || budget.maxCostUsd > 1000) throw new Error('每轮预估费用上限须为 0.01–1000 USD');
  if (!Number.isSafeInteger(budget.maxDurationMs) || (budget.maxDurationMs as number) < 60_000 || (budget.maxDurationMs as number) > 3_600_000) throw new Error('最长运行时间须为 1–60 分钟');
  return {
    version: 1,
    legacyProviders: root.legacyProviders === true,
    classifier: {
      mode: classifier.mode, baseURL: validateRoutingBaseURL(classifier.baseURL), model: validateRoutingModel(classifier.model),
      timeoutMs: classifier.timeoutMs as number, promptVersion: 'v3',
    },
    planning: { mode: planning.mode, executionMode: (planning.executionMode ?? 'auto') as 'auto' | 'confirm' | 'only', ...(planning.modelId === undefined ? {} : { modelId: text(planning.modelId, '规划模型 ID') }) },
    ...(root.utilityModelId === undefined ? {} : { utilityModelId: text(root.utilityModelId, '归档模型 ID') }),
    budget: { maxCostUsd: budget.maxCostUsd as number, maxDurationMs: budget.maxDurationMs as number },
  };
}

export function loadRoutingSettings(filePath: string): RoutingSettings {
  try {
    if (fs.statSync(filePath).size > 100_000) throw new Error('路由设置文件过大');
    return validateRoutingSettings(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch { return structuredClone(DEFAULT_ROUTING_SETTINGS); }
}

/** Validation and atomic replacement finish before the caller updates live state. */
export function saveRoutingSettings(filePath: string, input: unknown): RoutingSettings {
  const settings = validateRoutingSettings(input);
  const temporary = filePath + '.' + process.pid + '.' + randomUUID() + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve the original write/rename error. */ }
  }
  return settings;
}
