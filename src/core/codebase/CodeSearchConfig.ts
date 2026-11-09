import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateRoutingModel } from '@core/routing/RoutingSettings';

export interface CodeSearchConfig {
  version: 1;
  enabled: boolean;
  model: string;
  timeoutMs: number;
  maxFiles: number;
  maxChunks: number;
  topK: number;
}

export const DEFAULT_CODE_SEARCH_CONFIG: CodeSearchConfig = {
  version: 1, enabled: false, model: '', timeoutMs: 10_000,
  maxFiles: 5_000, maxChunks: 10_000, topK: 8,
};

export function validateCodeSearchConfig(input: unknown): CodeSearchConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('代码语义检索配置必须是对象');
  const value = input as Record<string, unknown>;
  const allowed = Object.keys(DEFAULT_CODE_SEARCH_CONFIG);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('代码语义检索配置包含未知字段');
  if (value.version !== 1 || typeof value.enabled !== 'boolean') throw new Error('代码语义检索配置版本或启用状态无效');
  const number = (key: string, minimum: number, maximum: number): number => {
    const candidate = value[key];
    if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) throw new Error(key + ' 须为 ' + minimum + '–' + maximum + ' 的整数');
    return candidate as number;
  };
  if (typeof value.model !== 'string') throw new Error('请指定本机 embedding 模型');
  const model = value.model.trim() ? validateRoutingModel(value.model) : '';
  if (value.enabled && !model) throw new Error('启用语义检索前请选择已安装的本机 embedding 模型');
  return { version: 1, enabled: value.enabled, model, timeoutMs: number('timeoutMs', 250, 120_000), maxFiles: number('maxFiles', 1, 10_000), maxChunks: number('maxChunks', 1, 100_000), topK: number('topK', 1, 50) };
}

export function loadCodeSearchConfig(filePath: string): CodeSearchConfig {
  try {
    if (fs.statSync(filePath).size > 20_000) throw new Error('代码检索配置文件过大');
    return validateCodeSearchConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch { return { ...DEFAULT_CODE_SEARCH_CONFIG }; }
}

export function saveCodeSearchConfig(filePath: string, input: unknown): CodeSearchConfig {
  const config = validateCodeSearchConfig(input);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally { fs.rmSync(temporary, { force: true }); }
  return config;
}
