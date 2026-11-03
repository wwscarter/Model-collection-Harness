import type { ModelConfig } from './types';

export type ProviderCategory = 'official' | 'compatible_gateway' | 'custom_proxy' | 'local_ollama';
export type CapabilityName = 'code' | 'reasoning' | 'creative' | 'vision' | 'longcontext';
export interface SettingsDraft {
  name: string;
  provider: string;
  providerCategory: ProviderCategory;
  baseURL: string;
  apiKey: string;
  modelId: string;
  availableModels: string[];
  temperature: number;
  contextWindow: string;
  enableThinking: boolean;
  primary: boolean;
  enabled: boolean;
  maxTokens: string;
  intelligenceScore: string;
  priority: string;
  inputPrice: string;
  outputPrice: string;
  requestsPerMinute: string;
  tokensPerDay: string;
  capabilities: Record<CapabilityName, string>;
}

export const capabilityLabels: Array<{ key: CapabilityName; label: string }> = [
  { key: 'reasoning', label: '推理能力' }, { key: 'code', label: '代码能力' },
  { key: 'creative', label: '创意能力' }, { key: 'vision', label: '视觉能力' },
  { key: 'longcontext', label: '长上下文' },
];
export const providerLabels: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', deepseek: 'DeepSeek', custom: 'OpenAI 兼容',
};
export const providerDefaults: Record<string, string> = {
  openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta', deepseek: 'https://api.deepseek.com/v1',
};
export const categoryLabels: Record<ProviderCategory, string> = {
  official: '官方直连', compatible_gateway: '兼容网关', custom_proxy: '自建反代', local_ollama: '本地实例',
};

export function createSettingsDraft(model?: ModelConfig): SettingsDraft {
  const capabilities = Object.fromEntries(capabilityLabels.map(({ key }) => [key, String(model?.capabilities.find((entry) => entry.type === key)?.score ?? (key === 'reasoning' ? 70 : 0))])) as Record<CapabilityName, string>;
  return {
    name: model?.name ?? '', provider: model?.provider ?? 'custom',
    providerCategory: model?.providerCategory ?? (model?.provider && model.provider !== 'custom' ? 'official' : 'compatible_gateway'),
    baseURL: model?.baseURL ?? (model ? providerDefaults[model.provider] ?? '' : ''), apiKey: '',
    modelId: model?.modelId ?? '', availableModels: [...new Set([...(model?.availableModels ?? []), ...(model?.modelId ? [model.modelId] : [])])],
    temperature: model?.temperature ?? 0.6, contextWindow: String(model?.contextWindow ?? model?.maxTokens ?? 64000),
    enableThinking: model?.enableThinking ?? true, primary: model?.isPrimary ?? false,
    enabled: model?.enabled ?? true, maxTokens: String(model?.maxTokens ?? 4096),
    intelligenceScore: String(model?.intelligenceScore ?? capabilities.reasoning), priority: String(model?.priority ?? 0),
    inputPrice: String(model?.costPer1kTokens.input ?? 0), outputPrice: String(model?.costPer1kTokens.output ?? 0),
    requestsPerMinute: String(model?.rateLimit?.requestsPerMinute ?? 60), tokensPerDay: String(model?.rateLimit?.tokensPerDay ?? 100000), capabilities,
  };
}

/** Validate before persistence; omit blank credentials when editing to retain the saved key. */
export function settingsPayload(draft: SettingsDraft, editing: boolean): Omit<ModelConfig, 'id'> {
  if (!draft.name.trim()) throw new Error('请填写模型名称');
  if (!draft.modelId.trim()) throw new Error('请选择或添加一个模型标识');
  const baseURL = draft.baseURL.trim();
  if (!baseURL && draft.provider === 'custom') throw new Error('请填写 API 地址');
  if (baseURL) {
    try { const url = new URL(baseURL); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
    catch { throw new Error('API 地址必须是有效的 http 或 https URL'); }
  }
  const number = (value: string, label: string, min = 0, max = Infinity, integer = false) => {
    const parsed = Number(value);
    if (!value.trim() || !Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) throw new Error(label + '的数值无效');
    return parsed;
  };
  const contextWindow = number(draft.contextWindow, '上下文窗口', 1, Infinity, true);
  const maxTokens = number(draft.maxTokens, '最大输出 Token', 1, contextWindow, true);
  const intelligenceScore = number(draft.intelligenceScore, '综合智能度', 0, 100);
  const maxTemperature = draft.provider === 'anthropic' ? 1 : 1.5;
  if (!Number.isFinite(draft.temperature) || draft.temperature < 0 || draft.temperature > maxTemperature) throw new Error('采样温度必须在 0.0 到 ' + maxTemperature.toFixed(1) + ' 之间');
  const apiKey = draft.apiKey.trim();
  return {
    name: draft.name.trim(), provider: draft.provider, providerCategory: draft.providerCategory,
    baseURL: baseURL || undefined, modelId: draft.modelId.trim(),
    ...(!editing || apiKey ? { apiKey } : {}),
    availableModels: [...new Set([...draft.availableModels, draft.modelId].map((id) => id.trim()).filter(Boolean))],
    temperature: draft.temperature, contextWindow, enableThinking: draft.enableThinking,
    enabled: draft.primary || draft.enabled, isPrimary: draft.primary, maxTokens, intelligenceScore, priority: number(draft.priority, '优先级', -Infinity, Infinity, true),
    capabilities: capabilityLabels.map(({ key, label }) => ({ type: key, score: number(draft.capabilities[key], label, 0, 100) })).filter((entry) => entry.score > 0),
    costPer1kTokens: { input: number(draft.inputPrice, '输入价格'), output: number(draft.outputPrice, '输出价格') },
    rateLimit: { requestsPerMinute: number(draft.requestsPerMinute, '每分钟请求数', 0, Infinity, true), tokensPerDay: number(draft.tokensPerDay, '每日 Token 限额', 0, Infinity, true) },
  };
}
