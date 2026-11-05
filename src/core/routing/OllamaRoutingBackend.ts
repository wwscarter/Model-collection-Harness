import type { LocalRoutingClassification, RoutingClassificationContext, RoutingClassificationOptions, RoutingClassifier, RoutingClassifierStatus } from './LocalRoutingModel';
import { buildRoutingPrompt, prepareRoutingInput, ROUTING_COMPLEXITIES, ROUTING_JSON_SCHEMA, ROUTING_TASK_TYPES } from './RoutingPrompts';
import { DEFAULT_ROUTING_SETTINGS, validateRoutingSettings, type RoutingSettings } from './RoutingSettings';

type ClassifierConfig = RoutingSettings['classifier'];
type JsonRecord = Record<string, unknown>;
const MODEL_CACHE_MS = 30_000;
const CIRCUIT_MS = 15_000;
const WARMUP_TIMEOUT_MS = 30_000;

export class OllamaRoutingError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'OllamaRoutingError'; }
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function aborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason ?? new Error('任务已取消')); };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then((result) => { signal.removeEventListener('abort', onAbort); resolve(result); }, (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
    if (signal.aborted) onAbort();
  });
}

/** A role-specific local classifier; it never downloads models or owns the daemon. */
export class OllamaRoutingBackend implements RoutingClassifier {
  private readonly config: ClassifierConfig;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly lifetime = new AbortController();
  private state: RoutingClassifierStatus;
  private busy = false;
  private failures = 0;
  private verifiedUntil = 0;
  private backendVersion?: string;
  private modelDigest?: string;

  constructor(config: ClassifierConfig, options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.config = validateRoutingSettings({ ...DEFAULT_ROUTING_SETTINGS, classifier: config }).classifier;
    this.request = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.state = { backend: 'ollama', configured: true, available: false, model: this.config.model, promptVersion: this.config.promptVersion, warmingUp: false };
  }

  getStatus(): RoutingClassifierStatus {
    const circuitOpen = Boolean(this.state.circuitOpenUntil && this.state.circuitOpenUntil > this.now());
    return { ...this.state, available: this.state.available && !circuitOpen && !this.lifetime.signal.aborted, ...(circuitOpen ? {} : { circuitOpenUntil: undefined }) };
  }

  async classify(context: RoutingClassificationContext, options: RoutingClassificationOptions = {}): Promise<LocalRoutingClassification> {
    return this.exclusive('classify', options.signal, async (signal) => {
      if (this.verifiedUntil <= this.now() || !this.state.reachable || !this.state.modelInstalled) await this.probeInternal(signal);
      if (!this.state.loaded) throw new OllamaRoutingError('cold', 'Ollama classifier model is not loaded; preparing model in the background, use rules for this request');
      const prepared = prepareRoutingInput(context);
      const result = await this.complete(prepared.context, signal);
      this.state.loaded = true;
      return { ...result, backend: 'ollama', model: this.config.model, backendVersion: this.backendVersion, modelDigest: this.modelDigest, promptVersion: prepared.exampleCount ? 'v3+feedback' : this.config.promptVersion, inputTruncated: prepared.inputTruncated, exampleCount: prepared.exampleCount, rationale: 'Ollama v3 task classification' };
    });
  }

  async probe(signal?: AbortSignal): Promise<RoutingClassifierStatus> {
    try { await this.exclusive('probe', signal, (activeSignal) => this.probeInternal(activeSignal)); }
    catch (error) {
      signal?.throwIfAborted();
      if (this.lifetime.signal.aborted) throw error;
      // Health failures are represented as status; caller cancellation is not a health failure.
      if (error instanceof OllamaRoutingError && error.code === 'busy') return { ...this.getStatus(), lastError: error.message };
    }
    return this.getStatus();
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    return this.exclusive('list', signal, async (activeSignal) => {
      const models = await this.tags(activeSignal);
      return models.filter((item) => this.local(item)).map((item) => String(item.name ?? item.model)).filter(Boolean);
    });
  }

  async warmup(signal?: AbortSignal, context?: RoutingClassificationContext): Promise<void> {
    await this.exclusive('warmup', signal, async (activeSignal) => {
      await this.probeInternal(activeSignal);
      // Preserve the confirmed-example prefix after a foreground timeout. Warming
      // only the plain v3 prefix can evict the feedback prefix needed on retry.
      await this.complete({ ...context, type: 'general', description: '你好。' }, activeSignal);
      this.state.loaded = true;
    });
  }

  dispose(): void {
    this.lifetime.abort(new OllamaRoutingError('disposed', 'Ollama routing backend disposed'));
    this.state.available = false;
    this.state.warmingUp = false;
  }

  private async exclusive<T>(kind: 'classify' | 'probe' | 'list' | 'warmup', external: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    external?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (this.busy) throw new OllamaRoutingError('busy', this.state.warmingUp ? 'Ollama classifier is warming up; use rules for this request' : 'Ollama classifier is busy; use rules for this request');
    if (this.state.circuitOpenUntil && this.state.circuitOpenUntil > this.now()) throw new OllamaRoutingError('circuit-open', 'Ollama classifier circuit is open until ' + new Date(this.state.circuitOpenUntil).toISOString());
    if (this.state.circuitOpenUntil) { this.state.circuitOpenUntil = undefined; this.failures = 0; }
    this.busy = true;
    this.state.warmingUp = kind === 'warmup';
    const startedAt = this.now();
    const timeout = new AbortController();
    const timeoutMs = kind === 'warmup' ? WARMUP_TIMEOUT_MS : this.config.timeoutMs;
    const timer = setTimeout(() => timeout.abort(new OllamaRoutingError('timeout', 'Ollama classifier timed out after ' + timeoutMs + ' ms')), timeoutMs);
    const signal = AbortSignal.any([this.lifetime.signal, timeout.signal, ...(external ? [external] : [])]);
    try {
      const result = await aborted(work(signal), signal);
      signal.throwIfAborted();
      if (kind !== 'list') {
        this.failures = 0;
        this.state.lastError = undefined;
        this.state.circuitOpenUntil = undefined;
        this.state.available = Boolean(this.state.reachable && this.state.modelInstalled);
      }
      this.state.lastLatencyMs = Math.max(0, this.now() - startedAt);
      if (kind === 'classify' && result && typeof result === 'object') Object.assign(result, { durationMs: this.state.lastLatencyMs });
      return result;
    } catch (failure) {
      external?.throwIfAborted();
      this.lifetime.signal.throwIfAborted();
      const error = timeout.signal.aborted ? timeout.signal.reason as Error : failure instanceof Error ? failure : new Error(String(failure));
      this.state.lastError = error.message;
      this.state.lastLatencyMs = Math.max(0, this.now() - startedAt);
      if (error instanceof OllamaRoutingError && error.code === 'cold') {
        this.state.available = Boolean(this.state.reachable && this.state.modelInstalled);
        throw error;
      }
      this.state.available = false;
      this.verifiedUntil = 0;
      if (error instanceof OllamaRoutingError && error.code === 'offline') { this.state.reachable = false; this.state.loaded = false; }
      if (kind !== 'warmup') {
        this.failures += 1;
        if (this.failures >= 3) this.state.circuitOpenUntil = this.now() + CIRCUIT_MS;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.busy = false;
      this.state.warmingUp = false;
    }
  }

  private local(item: JsonRecord): boolean {
    const name = String(item.name ?? item.model ?? '');
    const details = record(item.details);
    return Boolean(name) && !/(?:^|[-:/_.])cloud(?:$|[-:/_.])/i.test(name) && !item.remote_host && !item.remote_model && !details?.remote_host;
  }

  private matches(item: JsonRecord): boolean {
    return [item.name, item.model].some((name) => name === this.config.model || name === this.config.model + ':latest');
  }

  private async tags(signal: AbortSignal): Promise<JsonRecord[]> {
    const data = await this.json('/api/tags', signal);
    if (!Array.isArray(data.models) || data.models.some((item) => !record(item) || typeof (item.name ?? item.model) !== 'string')) throw new OllamaRoutingError('metadata', 'Ollama returned invalid model metadata');
    return data.models as JsonRecord[];
  }

  private async probeInternal(signal: AbortSignal): Promise<void> {
    const version = await this.json('/api/version', signal);
    if (typeof version.version !== 'string' || !version.version) throw new OllamaRoutingError('metadata', 'Ollama returned an invalid backend version');
    this.backendVersion = version.version;
    this.state.backendVersion = this.backendVersion;
    this.state.reachable = true;
    const models = await this.tags(signal);
    const model = models.find((item) => this.matches(item));
    this.state.modelInstalled = Boolean(model && this.local(model));
    if (!this.state.modelInstalled) { this.state.loaded = false; throw new OllamaRoutingError('model-missing', 'Local Ollama model is not installed: ' + this.config.model); }
    this.modelDigest = typeof model!.digest === 'string' ? model!.digest : undefined;
    this.state.modelDigest = this.modelDigest;
    if (Array.isArray(model!.capabilities) && !model!.capabilities.includes('completion')) throw new OllamaRoutingError('capability', 'Ollama model does not support text completion: ' + this.config.model);
    const running = await this.json('/api/ps', signal);
    if (!Array.isArray(running.models)) throw new OllamaRoutingError('metadata', 'Ollama returned invalid loaded-model metadata');
    this.state.loaded = running.models.some((item) => record(item) && this.matches(item));
    signal.throwIfAborted();
    this.verifiedUntil = this.now() + MODEL_CACHE_MS;
  }

  private async complete(context: RoutingClassificationContext, signal: AbortSignal): Promise<Pick<LocalRoutingClassification, 'taskType' | 'complexity' | 'confidence'>> {
    const data = await this.json('/api/chat', signal, {
      model: this.config.model, messages: [{ role: 'user', content: buildRoutingPrompt(context) }],
      format: ROUTING_JSON_SCHEMA, think: false, stream: false, keep_alive: '5m',
      options: { temperature: 0, num_ctx: 2048, num_predict: 80, num_thread: 4, num_gpu: 0 },
    });
    if (data.done !== true || typeof record(data.message)?.content !== 'string') throw new OllamaRoutingError('invalid-output', 'Ollama did not return a complete classification');
    const content = record(data.message)!.content as string;
    let result: JsonRecord | undefined;
    try { result = record(JSON.parse(content)); } catch { throw new OllamaRoutingError('invalid-json', 'Ollama classification is not valid JSON'); }
    if (!result || Object.keys(result).some((key) => !['taskType', 'complexity', 'confidence'].includes(key))
      || !ROUTING_TASK_TYPES.includes(result.taskType as typeof ROUTING_TASK_TYPES[number])
      || !ROUTING_COMPLEXITIES.includes(result.complexity as typeof ROUTING_COMPLEXITIES[number])
      || typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) throw new OllamaRoutingError('schema', 'Ollama classification failed the taskType/complexity/confidence JSON schema');
    return { taskType: result.taskType as LocalRoutingClassification['taskType'], complexity: result.complexity as LocalRoutingClassification['complexity'], confidence: result.confidence };
  }

  private async json(route: string, signal: AbortSignal, body?: unknown): Promise<JsonRecord> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await aborted(this.request(this.config.baseURL + route, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      }), signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new OllamaRoutingError('offline', 'Ollama is unreachable: ' + (error instanceof Error ? error.message : String(error)));
    }
    signal.throwIfAborted();
    if (!response.ok) {
      const detail = (await aborted(response.text(), signal)).slice(0, 300);
      throw new OllamaRoutingError('http', 'Ollama ' + route + ' failed (HTTP ' + response.status + '): ' + detail);
    }
    let parsed: unknown;
    try { parsed = await aborted(response.json(), signal); }
    catch { signal.throwIfAborted(); throw new OllamaRoutingError('invalid-json', 'Ollama ' + route + ' returned invalid JSON'); }
    signal.throwIfAborted();
    const data = record(parsed);
    if (!data) throw new OllamaRoutingError('invalid-json', 'Ollama ' + route + ' returned a non-object response');
    if (data.error) throw new OllamaRoutingError('backend', 'Ollama ' + route + ': ' + String(data.error).slice(0, 300));
    return data;
  }
}
