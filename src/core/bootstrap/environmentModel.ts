import type { ModelConfig, ModelProvider } from '@core/models/ModelConfig';
import { hasUsableCredentials, validateModelConfig } from '@core/models/ModelConfig';

/** Explicit, in-memory configuration for standalone hosts; it never writes credentials. */
export function readEnvironmentModel(environment: NodeJS.ProcessEnv = process.env, prefixes: readonly string[] = ['NEWAI']): ModelConfig | undefined {
  const get = (name: string): string | undefined => prefixes.map((prefix) => environment[prefix + '_' + name]).find((value) => value !== undefined && value.trim() !== '')?.trim();
  const modelId = get('MODEL_ID');
  if (!modelId) return undefined;
  const baseURL = get('BASE_URL');
  const provider = (get('PROVIDER') ?? (baseURL ? 'custom' : 'openai')) as ModelProvider;
  const price = (name: string) => {
    const value = get(name);
    const parsed = value === undefined ? 0 : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(prefixes[0] + '_' + name + ' 须为非负数字');
    return parsed;
  };
  const now = new Date();
  const model: ModelConfig = {
    id: 'environment-model', name: modelId, provider, apiKey: get('API_KEY') ?? '', baseURL, modelId,
    enabled: true, isPrimary: true, providerCategory: baseURL ? 'compatible_gateway' : 'official',
    contextWindow: 128_000, maxTokens: 4096, capabilities: [{ type: 'code', score: 70 }, { type: 'reasoning', score: 70 }],
    costPer1kTokens: { input: price('INPUT_COST_PER_1K'), output: price('OUTPUT_COST_PER_1K') }, rateLimit: { requestsPerMinute: 60, tokensPerDay: 1_000_000 }, priority: 0, createdAt: now, updatedAt: now,
  };
  validateModelConfig(model);
  if (!hasUsableCredentials(model)) throw new Error('环境变量模型需要 API Key：' + prefixes[0] + '_API_KEY');
  return model;
}
