import { validateRoutingBaseURL, validateRoutingModel } from '@core/routing/RoutingSettings';
import { awaitWithSignal } from '@core/tools/awaitWithSignal';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'EmbeddingUnavailableError'; }
}

/** Talks only to the existing local daemon. No model installation endpoint is used. */
export class EmbeddingClient {
  private readonly baseURL: string;
  private readonly model: string;
  private confirmedLocal = false;

  constructor(baseURL: string, model: string, private readonly timeoutMs = 10_000, private readonly request: typeof fetch = globalThis.fetch) {
    this.baseURL = validateRoutingBaseURL(baseURL);
    this.model = validateRoutingModel(model);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 120_000) throw new Error('embedding 超时须为 250–120000 毫秒');
  }

  async probe(signal?: AbortSignal): Promise<{ model: string; digest: string }> {
    const tags = await this.json('/api/tags', undefined, signal);
    if (!Array.isArray(tags.models)) throw new EmbeddingUnavailableError('Ollama 未返回有效的本机模型列表');
    const match = tags.models.map(record).find((item) => item && [item.name, item.model].some((name) => name === this.model || name === this.model + ':latest'));
    if (!match || !this.local(match)) throw new EmbeddingUnavailableError('指定的本机 embedding 模型尚未安装或不可用：' + this.model);
    const details = await this.json('/api/show', { model: this.model }, signal);
    if (!this.local(details) || !Array.isArray(details.capabilities) || !details.capabilities.includes('embedding')) throw new EmbeddingUnavailableError('该本机模型未确认支持 embedding：' + this.model);
    if (typeof match.digest !== 'string' || !match.digest) throw new EmbeddingUnavailableError('Ollama 未提供 embedding 模型版本摘要');
    this.confirmedLocal = true;
    return { model: this.model, digest: match.digest };
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!texts.length || texts.length > 32 || texts.some((text) => !text || text.length > 12_000)) throw new Error('embedding 输入须为 1–32 段且每段不超过 12000 字符');
    if (!this.confirmedLocal) await this.probe(signal);
    // Explicit truncate=false makes an unsupported context size visible to the caller.
    const response = await this.json('/api/embed', { model: this.model, input: texts, truncate: false, keep_alive: '5m' }, signal);
    if (!Array.isArray(response.embeddings) || response.embeddings.length !== texts.length) throw new EmbeddingUnavailableError('Ollama 返回的 embedding 数量无效');
    const vectors = response.embeddings as unknown[];
    if (vectors.some((vector) => !Array.isArray(vector) || !vector.length || vector.length > 8_192 || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value)) || !vector.some((value) => value !== 0))) throw new EmbeddingUnavailableError('Ollama 返回的 embedding 向量无效');
    const dimension = (vectors[0] as number[]).length;
    if (vectors.some((vector) => (vector as number[]).length !== dimension)) throw new EmbeddingUnavailableError('Ollama 返回的 embedding 维度不一致');
    return vectors as number[][];
  }

  private local(item: RecordValue): boolean {
    const details = record(item.details);
    return !item.remote_host && !item.remote_model && !details?.remote_host;
  }

  private async json(route: string, body: unknown, external?: AbortSignal): Promise<RecordValue> {
    external?.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new EmbeddingUnavailableError('本机 embedding 请求超时')), this.timeoutMs);
    const signal = AbortSignal.any([timeout.signal, ...(external ? [external] : [])]);
    try {
      const response = await awaitWithSignal(this.request(this.baseURL + route, {
        method: body === undefined ? 'GET' : 'POST', signal, redirect: 'error',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      }), signal);
      const text = await awaitWithSignal(response.text(), signal);
      if (!response.ok) throw new EmbeddingUnavailableError('本机 embedding 服务返回 HTTP ' + response.status);
      if (text.length > 4_000_000) throw new EmbeddingUnavailableError('本机 embedding 响应过大');
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new EmbeddingUnavailableError('本机 embedding 服务未返回有效 JSON'); }
      const value = record(parsed);
      if (!value || value.error) throw new EmbeddingUnavailableError('本机 embedding 服务无法处理请求');
      signal.throwIfAborted();
      return value;
    } catch (error) {
      external?.throwIfAborted();
      if (timeout.signal.aborted) throw timeout.signal.reason;
      throw error instanceof EmbeddingUnavailableError ? error : new EmbeddingUnavailableError('无法连接本机 embedding 服务：' + (error instanceof Error ? error.message : String(error)));
    } finally { clearTimeout(timer); }
  }
}
