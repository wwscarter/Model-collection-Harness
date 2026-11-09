import {
  createModels, createProvider, envApiKeyAuth, InMemoryCredentialStore, lazyApi,
  type AssistantMessage, type Model, type ModelsSimpleStreamOptions, type ProviderStreams,
} from '@earendil-works/pi-ai';
import { toPiModel, type PiApi } from '@core/agent/modelMapping';
import { assertPromptFits, modelContextBudget } from '@core/context/ContextBudget';
import type { ModelConfig } from '@core/models/ModelConfig';
import type { InvokeConfig, ModelProvider, ModelResponse, ModelStreamChunk } from './ModelProvider';

const implementations: Record<PiApi, ProviderStreams> = {
  'openai-completions': lazyApi(() => import('@earendil-works/pi-ai/api/openai-completions')),
  'anthropic-messages': lazyApi(() => import('@earendil-works/pi-ai/api/anthropic-messages')),
  'google-generative-ai': lazyApi(() => import('@earendil-works/pi-ai/api/google-generative-ai')),
};

const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));
function count(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** The same Pi protocols and model mapping used by the agent loop, without a session or disk store. */
export class PiProvider implements ModelProvider {
  readonly modelId: string;
  private readonly models;
  private readonly piModel: Model<PiApi>;
  private readonly ready: Promise<unknown>;
  private readonly mapping;
  private readonly query: URLSearchParams;

  constructor(private readonly model: ModelConfig) {
    this.modelId = model.id;
    this.mapping = toPiModel(model);
    const mapping = this.mapping;
    const baseURL = new URL(mapping.provider.baseUrl);
    this.query = new URLSearchParams(baseURL.search);
    if (model.provider === 'google' && baseURL.search) throw new Error('Google 的统一 Pi 适配器暂不支持 API 地址查询参数，请在运行设置中选择旧版适配器。');
    baseURL.search = '';
    const baseUrl = baseURL.toString().replace(/\/+$/, '');
    const credentials = new InMemoryCredentialStore();
    this.models = createModels({ credentials });
    this.piModel = {
      ...mapping.provider.models[0],
      provider: mapping.providerId, api: mapping.provider.api, baseUrl,
    } as Model<PiApi>;
    this.models.setProvider(createProvider({
      id: mapping.providerId, name: model.name, baseUrl,
      models: [this.piModel], auth: { apiKey: envApiKeyAuth(model.name, []) },
      api: implementations[mapping.provider.api],
    }));
    this.ready = credentials.modify(mapping.providerId, async () => ({ type: 'api_key', key: mapping.apiKey }));
  }

  private options(prompt: string, config: InvokeConfig, signal = config.signal): ModelsSimpleStreamOptions {
    const requested = config.maxTokens ?? 2000;
    if (!Number.isInteger(requested) || requested <= 0) throw new Error('maxTokens must be a positive integer');
    const budget = modelContextBudget([this.model], requested);
    assertPromptFits(prompt, budget);
    return {
      maxTokens: budget.maxOutputTokens,
      temperature: config.temperature ?? this.model.temperature ?? 0.7,
      reasoning: this.mapping.thinkingLevel === 'off' ? undefined : this.mapping.thinkingLevel,
      signal, maxRetries: 0,
      // newAi has already reserved input/context room. Pi's extra 4096-token reserve
      // otherwise collapses ordinary legacy configurations with small windows to one token.
      onPayload: (payload) => {
        const body = payload as Record<string, any>;
        if (this.model.provider === 'google') return { ...body, config: { ...body.config, maxOutputTokens: budget.maxOutputTokens } };
        const key = 'max_completion_tokens' in body ? 'max_completion_tokens' : 'max_tokens';
        return { ...body, [key]: budget.maxOutputTokens };
      },
      ...(this.query.size ? {
        // SDKs append protocol paths to baseUrl. Add gateway query values only after that step.
        fetch: (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : input);
          for (const [name, value] of this.query) url.searchParams.append(name, value);
          return fetch(input instanceof Request ? new Request(url, input) : url, init);
        },
      } : {}),
      // Pi needs an internal placeholder for keyless gateways. Do not send that placeholder.
      ...(this.model.provider === 'custom' && !this.model.apiKey ? {
        transformHeaders: (headers) => ({ ...headers, authorization: null }),
      } : {}),
    };
  }

  private context(prompt: string) {
    return { messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }] };
  }

  private response(message: AssistantMessage, prompt: string): ModelResponse {
    if (message.stopReason === 'aborted') throw new Error(message.errorMessage || 'Model request aborted');
    if (message.stopReason === 'error' || message.stopReason === 'pending') throw new Error(message.errorMessage || 'Model request failed');
    const content = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
    if (!content.trim()) throw new Error('Model returned an empty text response');
    const usage = message.usage;
    const input = [usage.input, usage.cacheRead, usage.cacheWrite].map(count);
    const output = count(usage.output);
    const inputTokens = input.every((value) => value !== undefined) ? input.reduce<number>((sum, value) => sum + value!, 0) : undefined;
    // Pi uses zero counters when a compatible endpoint omits usage entirely.
    const hasUsage = inputTokens !== undefined && output !== undefined && inputTokens + output > 0;
    return {
      content, inputTokens: hasUsage ? inputTokens : estimateTokens(prompt),
      outputTokens: hasUsage ? output : estimateTokens(content), modelId: this.modelId, stopReason: message.stopReason,
    };
  }

  async invoke(prompt: string, config: InvokeConfig = {}): Promise<ModelResponse> {
    config.signal?.throwIfAborted();
    const options = this.options(prompt, config);
    await this.ready;
    config.signal?.throwIfAborted();
    const message = await this.models.completeSimple(this.piModel, this.context(prompt), options);
    config.signal?.throwIfAborted();
    return this.response(message, prompt);
  }

  async *invokeStream(prompt: string, config: InvokeConfig = {}): AsyncIterable<ModelStreamChunk> {
    config.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = config.signal ? AbortSignal.any([config.signal, controller.signal]) : controller.signal;
    const options = this.options(prompt, config, signal);
    await this.ready;
    signal.throwIfAborted();
    const stream = this.models.streamSimple(this.piModel, this.context(prompt), options);
    try {
      for await (const event of stream) {
        signal.throwIfAborted();
        if (event.type === 'text_delta') yield { delta: event.delta };
        else if (event.type === 'error') throw new Error(event.error.errorMessage || 'Model request failed');
        else if (event.type === 'done') {
          const result = this.response(event.message, prompt);
          yield { delta: '', done: true, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
          return;
        }
      }
      throw new Error('Model stream terminated before completion');
    } finally { controller.abort(); }
  }
}
