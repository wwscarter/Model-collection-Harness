import type { ModelConfig, ModelProvider } from '../models/ModelConfig';
import { createProvider, resolveOpenAIEndpoint } from './ModelProvider';

/** Draft values are sent to the main process; saved credentials never return to the renderer. */
export interface ModelConnectionInput {
  id?: string;
  provider: string;
  baseURL?: string;
  apiKey?: string;
  modelId?: string;
  temperature?: number;
  enableThinking?: boolean;
  contextWindow?: number;
}

export interface ModelConnectionResult { success: boolean; latency?: number; error?: string; demo?: boolean; }
interface ModelLookup { getModel(id: string): ModelConfig | undefined; }
const providers: ModelProvider[] = ['openai', 'anthropic', 'google', 'deepseek', 'custom'];

export function resolveDraftModel(input: ModelConnectionInput, registry: ModelLookup): ModelConfig {
  if (!input || !providers.includes(input.provider as ModelProvider)) throw new Error('不支持的供应商类别');
  const saved = input.id ? registry.getModel(input.id) : undefined;
  if (input.id && !saved) throw new Error('模型配置已不存在，请重新选择');
  if (saved && saved.provider !== input.provider) throw new Error('供应商已更改，请显式填写新供应商的配置，不可复用其他供应商的凭据');
  const provider = input.provider as ModelProvider;
  const baseURL = input.baseURL !== undefined ? input.baseURL.trim() || undefined : saved?.baseURL;
  if (provider === 'custom' && !baseURL) throw new Error('请填写自定义端点的 API 地址');
  if (baseURL) {
    const url = new URL(baseURL);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('API 地址须使用 http 或 https');
  }
  const temperature = input.temperature ?? saved?.temperature ?? 0.6;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1.5) throw new Error('采样温度须为 0–1.5');
  if (provider === 'anthropic' && temperature > 1) throw new Error('Anthropic 采样温度须为 0–1');
  const now = new Date();
  return {
    ...saved,
    id: saved?.id ?? 'draft-connection',
    name: saved?.name ?? '未保存的模型',
    provider,
    baseURL,
    // An empty edit field preserves the existing secret, just like saving a draft.
    apiKey: input.apiKey?.trim() || saved?.apiKey || '',
    modelId: input.modelId?.trim() || saved?.modelId || '',
    temperature,
    enableThinking: input.enableThinking ?? saved?.enableThinking ?? true,
    contextWindow: input.contextWindow ?? saved?.contextWindow ?? 65_536,
    maxTokens: saved?.maxTokens ?? 4_096,
    capabilities: saved?.capabilities ?? [],
    costPer1kTokens: saved?.costPer1kTokens ?? { input: 0, output: 0 },
    rateLimit: saved?.rateLimit ?? { requestsPerMinute: 60, tokensPerDay: 1_000_000 },
    enabled: saved?.enabled ?? false,
    priority: saved?.priority ?? 0,
    createdAt: saved?.createdAt ?? now,
    updatedAt: now,
  };
}

function discoveryURL(model: ModelConfig): URL {
  if (model.provider === 'google') {
    const url = new URL(model.baseURL || 'https://generativelanguage.googleapis.com/v1beta');
    const path = url.pathname.replace(/\/+$/, '');
    const root = path.includes('/models/') ? path.slice(0, path.indexOf('/models/')) : path.endsWith('/models') ? path.slice(0, -7) : path;
    url.pathname = `${root}/models`;
    url.searchParams.delete('alt');
    url.searchParams.set('key', model.apiKey);
    return url;
  }
  if (model.provider === 'anthropic') {
    const url = new URL(model.baseURL || 'https://api.anthropic.com/v1');
    const path = url.pathname.replace(/\/+$/, '').replace(/\/messages$/, '');
    url.pathname = path.endsWith('/models') ? path : `${path}/models`;
    return url;
  }
  const url = new URL(resolveOpenAIEndpoint(model.baseURL || (model.provider === 'deepseek' ? 'https://api.deepseek.com/v1' : undefined)));
  url.pathname = url.pathname.replace(/\/chat\/completions$/, '/models');
  return url;
}

/** Uses each provider's model catalogue protocol, including its pagination. */
export async function fetchModelIdentifiers(input: ModelConnectionInput, registry: ModelLookup): Promise<{ models: string[] }> {
  const model = resolveDraftModel(input, registry);
  if (!model.apiKey && model.provider !== 'custom') throw new Error('请先填写 API Key，才能从该供应商获取模型');
  const url = discoveryURL(model);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (model.provider === 'anthropic') Object.assign(headers, { 'x-api-key': model.apiKey, 'anthropic-version': '2023-06-01' });
  else if (model.provider !== 'google' && model.apiKey) headers.authorization = `Bearer ${model.apiKey}`;
  const identifiers = new Set<string>();
  for (let page = 0; page < 10; page += 1) {
    const response = await fetch(url.toString(), { method: 'GET', headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}）`);
    const data = await response.json() as { data?: Array<{ id?: unknown }>; models?: Array<{ name?: unknown; supportedGenerationMethods?: string[] }>; has_more?: boolean; last_id?: string; nextPageToken?: string };
    const entries = model.provider === 'google' ? data.models : data.data;
    if (!Array.isArray(entries)) throw new Error('端点未返回兼容的模型列表，可手动添加模型 ID');
    for (const entry of entries) {
      if (model.provider === 'google') {
        const google = entry as { name?: unknown; supportedGenerationMethods?: string[] };
        if (google.supportedGenerationMethods && !google.supportedGenerationMethods.includes('generateContent')) continue;
        if (typeof google.name === 'string' && google.name.trim()) identifiers.add(google.name.trim().replace(/^models\//, ''));
      } else {
        const id = (entry as { id?: unknown }).id;
        if (typeof id === 'string' && id.trim()) identifiers.add(id.trim());
      }
    }
    if (model.provider === 'google' && data.nextPageToken) url.searchParams.set('pageToken', data.nextPageToken);
    else if (model.provider === 'anthropic' && data.has_more && data.last_id) url.searchParams.set('after_id', data.last_id);
    else return { models: [...identifiers] };
  }
  throw new Error('模型列表分页过多，请缩小端点范围或手动添加模型 ID');
}

export async function testModelConnection(input: ModelConnectionInput, registry: ModelLookup): Promise<ModelConnectionResult> {
  const started = Date.now();
  try {
    const model = resolveDraftModel(input, registry);
    if (!model.modelId) throw new Error('请先填写或选择模型 ID');
    if (!model.apiKey && model.provider !== 'custom') {
      return { success: false, demo: true, error: '尚未配置 API Key，当前为演示模式，未测试远程连接' };
    }
    await createProvider(model).invoke('Reply with the single word: connected', { maxTokens: 128, signal: AbortSignal.timeout(15_000) });
    return { success: true, latency: Date.now() - started, demo: false };
  } catch (error) {
    return { success: false, latency: Date.now() - started, error: error instanceof Error ? error.message : String(error), demo: false };
  }
}
