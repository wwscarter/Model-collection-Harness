import type { ModelConfig } from '@core/models/ModelConfig';

export interface InvokeConfig { temperature?: number; maxTokens?: number; signal?: AbortSignal; }
export interface ModelResponse { content: string; inputTokens: number; outputTokens: number; modelId: string; }
export interface ModelStreamChunk { delta: string; done?: boolean; inputTokens?: number; outputTokens?: number; }
export interface ModelProvider { readonly modelId?: string; invoke(prompt: string, config?: InvokeConfig): Promise<ModelResponse>; invokeStream?(prompt: string, config?: InvokeConfig): AsyncIterable<ModelStreamChunk>; }

const jsonHeaders = { 'content-type': 'application/json' };

class OpenAIProvider implements ModelProvider {
  readonly modelId: string;
  constructor(private readonly model: ModelConfig) { this.modelId = model.id; }
  async invoke(prompt: string, config: InvokeConfig = {}): Promise<ModelResponse> {
    const headers = { ...jsonHeaders, ...(this.model.apiKey ? { authorization: `Bearer ${this.model.apiKey}` } : {}) };
    const response = await fetch(resolveOpenAIEndpoint(this.model.baseURL), { method: 'POST', headers, body: JSON.stringify({ model: this.model.modelId, messages: [{ role: 'user', content: prompt }], temperature: config.temperature ?? 0.7, max_tokens: config.maxTokens ?? 2000 }), signal: config.signal });
    if (!response.ok) throw new Error(`OpenAI request failed (${response.status})`);
    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content ?? '';
    return { content, inputTokens: data.usage?.prompt_tokens ?? estimateTokens(prompt), outputTokens: data.usage?.completion_tokens ?? estimateTokens(content), modelId: this.model.id };
  }
  async *invokeStream(prompt: string, config: InvokeConfig = {}): AsyncIterable<ModelStreamChunk> {
    const headers = { ...jsonHeaders, ...(this.model.apiKey ? { authorization: `Bearer ${this.model.apiKey}` } : {}) };
    const response = await fetch(resolveOpenAIEndpoint(this.model.baseURL), { method: 'POST', headers, body: JSON.stringify({ model: this.model.modelId, messages: [{ role: 'user', content: prompt }], temperature: config.temperature ?? 0.7, max_tokens: config.maxTokens ?? 2000, stream: true, stream_options: { include_usage: true } }), signal: config.signal });
    if (!response.ok) throw new Error(`OpenAI request failed (${response.status})`);
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    for await (const data of parseSSE(response)) {
      if (data === '[DONE]') break;
      let parsed: any;
      try { parsed = JSON.parse(data); } catch { continue; }
      const delta = parsed.choices?.[0]?.delta?.content ?? '';
      inputTokens = parsed.usage?.prompt_tokens ?? inputTokens;
      outputTokens = parsed.usage?.completion_tokens ?? outputTokens;
      if (delta) yield { delta, inputTokens, outputTokens };
    }
    yield { delta: '', done: true, inputTokens: inputTokens ?? estimateTokens(prompt), outputTokens };
  }
}

class AnthropicProvider implements ModelProvider {
  readonly modelId: string;
  constructor(private readonly model: ModelConfig) { this.modelId = model.id; }
  async invoke(prompt: string, config: InvokeConfig = {}): Promise<ModelResponse> {
    const response = await fetch(this.model.baseURL ?? 'https://api.anthropic.com/v1/messages', { method: 'POST', headers: { ...jsonHeaders, 'x-api-key': this.model.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: this.model.modelId, max_tokens: config.maxTokens ?? 2000, temperature: config.temperature ?? 0.7, messages: [{ role: 'user', content: prompt }] }), signal: config.signal });
    if (!response.ok) throw new Error(`Anthropic request failed (${response.status})`);
    const data = await response.json() as any;
    const content = data.content?.map((part: any) => part.text ?? '').join('') ?? '';
    return { content, inputTokens: data.usage?.input_tokens ?? estimateTokens(prompt), outputTokens: data.usage?.output_tokens ?? estimateTokens(content), modelId: this.model.id };
  }
  async *invokeStream(prompt: string, config: InvokeConfig = {}): AsyncIterable<ModelStreamChunk> {
    const response = await fetch(this.model.baseURL ?? 'https://api.anthropic.com/v1/messages', { method: 'POST', headers: { ...jsonHeaders, 'x-api-key': this.model.apiKey, 'anthropic-version': '2023-06-01', accept: 'text/event-stream' }, body: JSON.stringify({ model: this.model.modelId, max_tokens: config.maxTokens ?? 2000, temperature: config.temperature ?? 0.7, messages: [{ role: 'user', content: prompt }], stream: true }), signal: config.signal });
    if (!response.ok) throw new Error(`Anthropic request failed (${response.status})`);
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let finished = false;
    for await (const data of parseSSE(response)) {
      let parsed: any;
      try { parsed = JSON.parse(data); } catch { continue; }
      inputTokens = parsed.message?.usage?.input_tokens ?? parsed.usage?.input_tokens ?? inputTokens;
      outputTokens = parsed.message?.usage?.output_tokens ?? parsed.usage?.output_tokens ?? outputTokens;
      const delta = parsed.delta?.text ?? parsed.content_block?.text ?? '';
      if (delta) yield { delta, inputTokens, outputTokens };
      if (parsed.type === 'message_stop') { finished = true; yield { delta: '', done: true, inputTokens: inputTokens ?? estimateTokens(prompt), outputTokens }; }
    }
    if (!finished) yield { delta: '', done: true, inputTokens: inputTokens ?? estimateTokens(prompt), outputTokens };
  }
}

class GoogleProvider implements ModelProvider {
  readonly modelId: string;
  constructor(private readonly model: ModelConfig) { this.modelId = model.id; }
  async invoke(prompt: string, config: InvokeConfig = {}): Promise<ModelResponse> {
    const base = this.model.baseURL ?? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model.modelId)}:generateContent`;
    const response = await fetch(`${base}?key=${encodeURIComponent(this.model.apiKey)}`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: config.temperature ?? 0.7, maxOutputTokens: config.maxTokens ?? 2000 } }), signal: config.signal });
    if (!response.ok) throw new Error(`Google request failed (${response.status})`);
    const data = await response.json() as any;
    const content = data.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? '').join('') ?? '';
    return { content, inputTokens: data.usageMetadata?.promptTokenCount ?? estimateTokens(prompt), outputTokens: data.usageMetadata?.candidatesTokenCount ?? estimateTokens(content), modelId: this.model.id };
  }
  async *invokeStream(prompt: string, config: InvokeConfig = {}): AsyncIterable<ModelStreamChunk> {
    const configured = this.model.baseURL ?? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model.modelId)}:streamGenerateContent`;
    const base = configured.includes(':generateContent') && !configured.includes(':streamGenerateContent') ? configured.replace(':generateContent', ':streamGenerateContent') : configured;
    const response = await fetch(`${base}?alt=sse&key=${encodeURIComponent(this.model.apiKey)}`, { method: 'POST', headers: { ...jsonHeaders, accept: 'text/event-stream' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: config.temperature ?? 0.7, maxOutputTokens: config.maxTokens ?? 2000 } }), signal: config.signal });
    if (!response.ok) throw new Error(`Google request failed (${response.status})`);
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    for await (const data of parseSSE(response)) {
      let parsed: any;
      try { parsed = JSON.parse(data); } catch { continue; }
      const delta = parsed.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? '').join('') ?? '';
      inputTokens = parsed.usageMetadata?.promptTokenCount ?? inputTokens;
      outputTokens = parsed.usageMetadata?.candidatesTokenCount ?? outputTokens;
      if (delta) yield { delta, inputTokens, outputTokens };
    }
    yield { delta: '', done: true, inputTokens: inputTokens ?? estimateTokens(prompt), outputTokens };
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
  if (!model.apiKey && model.provider !== 'custom') return new MockProvider(model);
  if (model.provider === 'openai' || model.provider === 'deepseek' || model.provider === 'custom') return new OpenAIProvider(model);
  if (model.provider === 'anthropic') return new AnthropicProvider(model);
  if (model.provider === 'google') return new GoogleProvider(model);
  return new MockProvider(model);
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

function estimateTokens(value: string): number { return Math.max(1, Math.ceil(value.length / 4)); }

/** Parse server-sent events from a fetch response without assuming a Node stream implementation. */
export async function* parseSSE(response: Response): AsyncIterable<string> {
  if (!response.body) throw new Error('Streaming response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
      if (done) break;
    }
    const data = buffer.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data) yield data;
  } finally { reader.releaseLock(); }
}
