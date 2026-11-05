import { hasUsableCredentials, type ModelConfig } from '@core/models/ModelConfig';

export interface InvokeConfig { temperature?: number; maxTokens?: number; signal?: AbortSignal; }
export interface ModelResponse { content: string; inputTokens: number; outputTokens: number; modelId: string; stopReason?: string; }
export interface ModelStreamChunk { delta: string; done?: boolean; inputTokens?: number; outputTokens?: number; }
export interface ModelProvider { readonly modelId?: string; invoke(prompt: string, config?: InvokeConfig): Promise<ModelResponse>; invokeStream?(prompt: string, config?: InvokeConfig): AsyncIterable<ModelStreamChunk>; }

const jsonHeaders = { 'content-type': 'application/json' };

function maxOutputTokens(model: ModelConfig, config: InvokeConfig): number {
  const requested = config.maxTokens ?? 2000;
  if (!Number.isInteger(requested) || requested <= 0) throw new Error('maxTokens must be a positive integer');
  return Math.min(model.maxTokens, requested);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function responseText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => part && typeof part.text === 'string' ? part.text : '').join('');
}

function assertProviderResponse(data: any, provider: string): void {
  if (!data?.error) return;
  const error = data.error;
  const message = typeof error === 'string' ? error : typeof error.message === 'string' ? error.message : 'Unknown provider error';
  throw new Error(`${provider} request failed: ${message}`);
}

function requireText(content: string, provider: string): string {
  if (!content.trim()) throw new Error(`${provider} returned an empty text response`);
  return content;
}

class OpenAIProvider implements ModelProvider {
  readonly modelId: string;
  constructor(private readonly model: ModelConfig) { this.modelId = model.id; }
  private thinkingParameters() {
    // The DeepSeek thinking switch is not part of the generic compatible protocol.
    return this.model.provider === 'deepseek' && this.model.enableThinking !== undefined
      ? { thinking: { type: this.model.enableThinking ? 'enabled' : 'disabled' } }
      : {};
  }
  async invoke(prompt: string, config: InvokeConfig = {}): Promise<ModelResponse> {
    const headers = { ...jsonHeaders, ...(this.model.apiKey ? { authorization: `Bearer ${this.model.apiKey}` } : {}) };
    const response = await fetch(resolveOpenAIEndpoint(this.model.baseURL ?? (this.model.provider === 'deepseek' ? 'https://api.deepseek.com/v1' : undefined)), { method: 'POST', headers, body: JSON.stringify({ model: this.model.modelId, messages: [{ role: 'user', content: prompt }], temperature: config.temperature ?? this.model.temperature ?? 0.7, max_tokens: maxOutputTokens(this.model, config), ...this.thinkingParameters() }), signal: config.signal });
    if (!response.ok) throw new Error(`OpenAI request failed (${response.status})`);
    const data = await response.json() as any;
    assertProviderResponse(data, 'OpenAI');
    const content = requireText(responseText(data.choices?.[0]?.message?.content), 'OpenAI');
    return { content, inputTokens: tokenCount(data.usage?.prompt_tokens) ?? estimateTokens(prompt), outputTokens: tokenCount(data.usage?.completion_tokens) ?? estimateTokens(content), modelId: this.model.id };
  }
  async *invokeStream(prompt: string, config: InvokeConfig = {}): AsyncIterable<ModelStreamChunk> {
    const headers = { ...jsonHeaders, ...(this.model.apiKey ? { authorization: `Bearer ${this.model.apiKey}` } : {}) };
    const response = await fetch(resolveOpenAIEndpoint(this.model.baseURL ?? (this.model.provider === 'deepseek' ? 'https://api.deepseek.com/v1' : undefined)), { method: 'POST', headers, body: JSON.stringify({ model: this.model.modelId, messages: [{ role: 'user', content: prompt }], temperature: config.temperature ?? this.model.temperature ?? 0.7, max_tokens: maxOutputTokens(this.model, config), stream: true, stream_options: { include_usage: true }, ...this.thinkingParameters() }), signal: config.signal });
    if (!response.ok) throw new Error(`OpenAI request failed (${response.status})`);
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let outputChars = 0;
    let finished = false;
    for await (const data of parseSSE(response)) {
      if (data === '[DONE]') { finished = true; break; }
      let parsed: any;
      try { parsed = JSON.parse(data); } catch { continue; }
      assertProviderResponse(parsed, 'OpenAI');
      const delta = responseText(parsed.choices?.[0]?.delta?.content);
      inputTokens = tokenCount(parsed.usage?.prompt_tokens) ?? inputTokens;
      outputTokens = tokenCount(parsed.usage?.completion_tokens) ?? outputTokens;
      if (parsed.choices?.some((choice: any) => choice.finish_reason != null)) finished = true;
      if (delta) { outputChars += delta.length; yield { delta, inputTokens, outputTokens }; }
    }
    if (!finished) throw new Error('OpenAI stream terminated before completion');
    if (!outputChars) throw new Error('OpenAI returned an empty text response');
    yield { delta: '', done: true, inputTokens: inputTokens ?? estimateTokens(prompt), outputTokens: outputTokens ?? Math.ceil(outputChars / 4) };
  }
}

class AnthropicProvider implements ModelProvider {
  readonly modelId: string;
  constructor(private readonly model: ModelConfig) { this.modelId = model.id; }
  async invoke(prompt: string, config: InvokeConfig = {}): Promise<ModelResponse> {
    const response = await fetch(resolveAnthropicEndpoint(this.model.baseURL), { method: 'POST', headers: { ...jsonHeaders, 'x-api-key': this.model.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: this.model.modelId, max_tokens: maxOutputTokens(this.model, config), temperature: config.temperature ?? this.model.temperature ?? 0.7, messages: [{ role: 'user', content: prompt }] }), signal: config.signal });
    if (!response.ok) throw new Error(`Anthropic request failed (${response.status})`);
    const data = await response.json() as any;
    assertProviderResponse(data, 'Anthropic');
    const content = requireText(responseText(data.content), 'Anthropic');
    return { content, inputTokens: tokenCount(data.usage?.input_tokens) ?? estimateTokens(prompt), outputTokens: tokenCount(data.usage?.output_tokens) ?? estimateTokens(content), modelId: this.model.id };
  }
  async *invokeStream(prompt: string, config: InvokeConfig = {}): AsyncIterable<ModelStreamChunk> {
    const response = await fetch(resolveAnthropicEndpoint(this.model.baseURL), { method: 'POST', headers: { ...jsonHeaders, 'x-api-key': this.model.apiKey, 'anthropic-version': '2023-06-01', accept: 'text/event-stream' }, body: JSON.stringify({ model: this.model.modelId, max_tokens: maxOutputTokens(this.model, config), temperature: config.temperature ?? this.model.temperature ?? 0.7, messages: [{ role: 'user', content: prompt }], stream: true }), signal: config.signal });
    if (!response.ok) throw new Error(`Anthropic request failed (${response.status})`);
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let finished = false;
    let outputChars = 0;
    for await (const data of parseSSE(response)) {
      let parsed: any;
      try { parsed = JSON.parse(data); } catch { continue; }
      assertProviderResponse(parsed, 'Anthropic');
      inputTokens = tokenCount(parsed.message?.usage?.input_tokens) ?? tokenCount(parsed.usage?.input_tokens) ?? inputTokens;
      outputTokens = tokenCount(parsed.message?.usage?.output_tokens) ?? tokenCount(parsed.usage?.output_tokens) ?? outputTokens;
      const delta = responseText(parsed.delta?.text ?? parsed.content_block?.text);
      if (delta) { outputChars += delta.length; yield { delta, inputTokens, outputTokens }; }
      if (parsed.type === 'message_stop') { finished = true; break; }
    }
    if (!finished) throw new Error('Anthropic stream terminated before completion');
    if (!outputChars) throw new Error('Anthropic returned an empty text response');
    yield { delta: '', done: true, inputTokens: inputTokens ?? estimateTokens(prompt), outputTokens: outputTokens ?? Math.ceil(outputChars / 4) };
  }
}

class GoogleProvider implements ModelProvider {
  readonly modelId: string;
  constructor(private readonly model: ModelConfig) { this.modelId = model.id; }
  async invoke(prompt: string, config: InvokeConfig = {}): Promise<ModelResponse> {
    const endpoint = resolveGoogleEndpoint(this.model.baseURL, this.model.modelId, this.model.apiKey);
    const response = await fetch(endpoint, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: config.temperature ?? this.model.temperature ?? 0.7, maxOutputTokens: maxOutputTokens(this.model, config) } }), signal: config.signal });
    if (!response.ok) throw new Error(`Google request failed (${response.status})`);
    const data = await response.json() as any;
    assertProviderResponse(data, 'Google');
    const content = requireText(responseText(data.candidates?.[0]?.content?.parts), 'Google');
    return { content, inputTokens: tokenCount(data.usageMetadata?.promptTokenCount) ?? estimateTokens(prompt), outputTokens: tokenCount(data.usageMetadata?.candidatesTokenCount) ?? estimateTokens(content), modelId: this.model.id };
  }
  async *invokeStream(prompt: string, config: InvokeConfig = {}): AsyncIterable<ModelStreamChunk> {
    const endpoint = resolveGoogleEndpoint(this.model.baseURL, this.model.modelId, this.model.apiKey, true);
    const response = await fetch(endpoint, { method: 'POST', headers: { ...jsonHeaders, accept: 'text/event-stream' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: config.temperature ?? this.model.temperature ?? 0.7, maxOutputTokens: maxOutputTokens(this.model, config) } }), signal: config.signal });
    if (!response.ok) throw new Error(`Google request failed (${response.status})`);
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let outputChars = 0;
    let finished = false;
    for await (const data of parseSSE(response)) {
      let parsed: any;
      try { parsed = JSON.parse(data); } catch { continue; }
      assertProviderResponse(parsed, 'Google');
      const delta = responseText(parsed.candidates?.[0]?.content?.parts);
      inputTokens = tokenCount(parsed.usageMetadata?.promptTokenCount) ?? inputTokens;
      outputTokens = tokenCount(parsed.usageMetadata?.candidatesTokenCount) ?? outputTokens;
      if (parsed.candidates?.some((candidate: any) => candidate.finishReason)) finished = true;
      if (delta) { outputChars += delta.length; yield { delta, inputTokens, outputTokens }; }
    }
    if (!finished) throw new Error('Google stream terminated before completion');
    if (!outputChars) throw new Error('Google returned an empty text response');
    yield { delta: '', done: true, inputTokens: inputTokens ?? estimateTokens(prompt), outputTokens: outputTokens ?? Math.ceil(outputChars / 4) };
  }
}

export class MockProvider implements ModelProvider {
  readonly modelId: string;
  constructor(private readonly model: ModelConfig) { this.modelId = model.id; }
  async invoke(prompt: string): Promise<ModelResponse> { const content = `已收到任务。当前模型「${this.model.name}」处于演示模式，未配置 API Key。\n\n任务摘要：${prompt.slice(0, 240)}`; return { content, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(content), modelId: this.model.id }; }
  async *invokeStream(prompt: string): AsyncIterable<ModelStreamChunk> {
    const content = (await this.invoke(prompt)).content;
    for (const part of content.match(/.{1,48}/gs) ?? [content]) { yield { delta: part }; }
    yield { delta: '', done: true, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(content) };
  }
}

export function createProvider(model: ModelConfig): ModelProvider {
  if (!hasUsableCredentials(model)) throw new Error(`模型「${model.name}」没有可用凭据，请检查 API Key`);
  if (model.provider === 'openai' || model.provider === 'deepseek' || model.provider === 'custom') return new OpenAIProvider(model);
  if (model.provider === 'anthropic') return new AnthropicProvider(model);
  if (model.provider === 'google') return new GoogleProvider(model);
  throw new Error(`Unsupported model provider: ${model.provider}`);
}

/** Accept either a full chat-completions endpoint or the common `/v1` base URL. */
export function resolveOpenAIEndpoint(baseURL?: string): string {
  const raw = (baseURL?.trim() || 'https://api.openai.com/v1/chat/completions').replace(/\/+$/, '');
  try {
    const url = new URL(raw);
    const pathname = url.pathname.replace(/\/+$/, '');
    if (pathname.endsWith('/chat/completions')) return url.toString();
    url.pathname = `${pathname}/chat/completions`;
    return url.toString();
  } catch {
    const queryIndex = raw.indexOf('?');
    if (queryIndex >= 0) return `${raw.slice(0, queryIndex)}/chat/completions${raw.slice(queryIndex)}`;
    return `${raw}/chat/completions`;
  }
}

export function resolveAnthropicEndpoint(baseURL?: string): string {
  const url = new URL(baseURL?.trim() || 'https://api.anthropic.com/v1');
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/messages')) url.pathname = `${pathname}/messages`;
  return url.toString();
}

export function resolveGoogleEndpoint(baseURL: string | undefined, modelId: string, apiKey: string, stream = false): string {
  const url = new URL(baseURL?.trim() || 'https://generativelanguage.googleapis.com/v1beta');
  const pathname = url.pathname.replace(/\/+$/, '');
  const modelPath = pathname.includes('/models/') ? pathname.slice(0, pathname.indexOf('/models/')) : pathname.endsWith('/models') ? pathname.slice(0, -7) : pathname;
  url.pathname = `${modelPath}/models/${encodeURIComponent(modelId.replace(/^models\//, ''))}:${stream ? 'streamGenerateContent' : 'generateContent'}`;
  url.searchParams.set('key', apiKey);
  if (stream) url.searchParams.set('alt', 'sse'); else url.searchParams.delete('alt');
  return url.toString();
}

function estimateTokens(value: string): number { return Math.max(1, Math.ceil(value.length / 4)); }

/** Parse server-sent events from a fetch response without assuming a Node stream implementation. */
export async function* parseSSE(response: Response): AsyncIterable<string> {
  if (!response.body) throw new Error('Streaming response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let exhausted = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
      if (done) { exhausted = true; break; }
    }
    const data = buffer.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data) yield data;
  } finally {
    try { if (!exhausted) await reader.cancel(); }
    catch { /* The request may already have been aborted. */ }
    finally { reader.releaseLock(); }
  }
}
