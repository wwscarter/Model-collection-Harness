import { createHash } from 'node:crypto';
import type { ModelConfig } from '@core/models/ModelConfig';

/** Pi API identifiers used by newAi's provider categories. */
export type PiApi = 'openai-completions' | 'anthropic-messages' | 'google-generative-ai';
export type PiThinkingLevel = 'off' | 'high';

/** Keyless local gateways (Ollama, vLLM) still need a placeholder: Pi refuses to send without one. */
export const PLACEHOLDER_API_KEY = 'newai-no-key';

export interface PiModelMapping {
  providerId: string;
  modelId: string;
  apiKey: string;
  thinkingLevel: PiThinkingLevel;
  provider: {
    name: string;
    baseUrl: string;
    api: PiApi;
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
      input: Array<'text'>;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
      samplingParams?: Record<string, unknown>;
      compat?: Record<string, unknown>;
    }>;
  };
}

const DEFAULT_BASE_URLS: Record<ModelConfig['provider'], string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  custom: '',
};

/**
 * Pi appends the protocol path itself (`/chat/completions`, `/v1/messages`,
 * `/models/<id>:streamGenerateContent`). Settings accept full endpoints too, so strip them here.
 */
export function normalizeBaseUrl(provider: ModelConfig['provider'], baseURL?: string): string {
  const raw = (baseURL?.trim() || DEFAULT_BASE_URLS[provider]).replace(/\/+$/, '');
  if (!raw) throw new Error('请填写自定义端点的 API 地址');
  const url = new URL(raw);
  let pathname = url.pathname.replace(/\/+$/, '');
  if (provider === 'anthropic') {
    pathname = pathname.replace(/\/messages$/, '').replace(/\/v1$/, '');
  } else if (provider === 'google') {
    const modelsIndex = pathname.indexOf('/models');
    if (modelsIndex >= 0) pathname = pathname.slice(0, modelsIndex);
    url.searchParams.delete('key');
    url.searchParams.delete('alt');
  } else {
    pathname = pathname.replace(/\/chat\/completions$/, '');
  }
  url.pathname = pathname || '/';
  url.hash = '';
  return url.toString().replace(/\/+$/, '').replace(/\/\?/, '?');
}

function apiFor(provider: ModelConfig['provider']): PiApi {
  if (provider === 'anthropic') return 'anthropic-messages';
  if (provider === 'google') return 'google-generative-ai';
  return 'openai-completions';
}

/** Stable, provider-safe id. Each newAi model gets its own Pi provider so keys never mix. */
export function piProviderId(model: Pick<ModelConfig, 'id'>): string {
  return `newai-${createHash('sha256').update(model.id).digest('hex').slice(0, 16)}`;
}

/** Translate a stored newAi model into the provider registration Pi's ModelRuntime expects. */
export function toPiModel(model: ModelConfig): PiModelMapping {
  const api = apiFor(model.provider);
  const deepseek = model.provider === 'deepseek';
  const gateway = model.provider === 'custom';
  const contextWindow = Math.max(1, model.contextWindow ?? model.maxTokens);
  const maxTokens = Math.max(1, Math.min(model.maxTokens, contextWindow));
  // Pi detects DeepSeek and gateways by provider id / host. newAi uses its own provider ids and
  // users may route through proxies, so declare the compat flags explicitly.
  const compat = deepseek
    ? { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true, supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' }
    // Generic gateways (OneAPI, Ollama, vLLM) often reject OpenAI-only fields.
    : gateway ? { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' } : undefined;
  return {
    providerId: piProviderId(model),
    modelId: model.modelId,
    apiKey: model.apiKey || PLACEHOLDER_API_KEY,
    // Only DeepSeek exposes newAi's thinking switch; other providers keep their default reasoning.
    thinkingLevel: deepseek && model.enableThinking !== false ? 'high' : 'off',
    provider: {
      name: model.name,
      baseUrl: normalizeBaseUrl(model.provider, model.baseURL),
      api,
      models: [{
        id: model.modelId,
        name: model.name,
        reasoning: deepseek,
        input: ['text'],
        // newAi prices calls itself (per 1K tokens); Pi's cost tracking stays at zero.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens,
        ...(api === 'openai-completions' && model.temperature !== undefined ? { samplingParams: { temperature: model.temperature } } : {}),
        ...(compat ? { compat } : {}),
      }],
    },
  };
}
