import { randomUUID } from 'node:crypto';
import type {
  RunStatus, RunTrace, SpanKind, SpanStatus, TraceEvent, TraceRunRecord,
  TraceSpanRecord, TraceStore,
} from './types';

export interface TraceSpanEnd {
  status?: SpanStatus;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  attributes?: Record<string, unknown>;
}

export interface TraceRunEnd {
  status?: RunStatus;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export interface TraceRecorderOptions {
  now?: () => Date;
  onEvent?: (event: TraceEvent) => void;
}

const MAX_ATTRIBUTES_CHARS = 4_000;

/** Keep trace metadata small and free of accidental full-file copies. */
function safeAttributes(attributes: Record<string, unknown> | undefined, maxChars = MAX_ATTRIBUTES_CHARS): Record<string, unknown> | undefined {
  if (!attributes) return undefined;
  try {
    const json = JSON.stringify(attributes);
    const snapshot = JSON.parse(json) as Record<string, unknown>;
    if (json.length <= maxChars) return snapshot;
    // Identity must survive a long routing explanation or many candidate snapshots.
    // Keep structured evidence first; the remainder is only a bounded preview.
    const bounded: Record<string, unknown> = { truncated: true };
    for (const key of ['modelId', 'modelSnapshot', 'role', 'classification', 'taskType', 'complexity', 'strategy', 'ruleId', 'pinned', 'attemptIndex', 'fallbackAttempts', 'planningModelId', 'alternatives', 'fallbackModels', 'alternativeSnapshots', 'fallbackSnapshots', 'attempts']) {
      if (snapshot[key] === undefined) continue;
      const candidate = { ...bounded, [key]: snapshot[key] };
      if (JSON.stringify(candidate).length <= maxChars - 160) bounded[key] = snapshot[key];
    }
    let preview = json.slice(0, Math.max(0, maxChars - JSON.stringify(bounded).length - 32));
    while (preview.length && JSON.stringify({ ...bounded, preview }).length > maxChars) preview = preview.slice(0, -32);
    return { ...bounded, ...(preview ? { preview } : {}) };
  } catch {
    return { truncated: true, reason: 'unserializable attributes' };
  }
}

export class TraceSpanHandle {
  constructor(
    private readonly recorder: TraceRecorder,
    private readonly span: TraceSpanRecord,
    private readonly root = false,
  ) {}

  get id(): string { return this.span.id; }
  get runId(): string { return this.span.runId; }
  get kind(): SpanKind { return this.span.kind; }

  child(kind: SpanKind, name: string, attributes?: Record<string, unknown>): TraceSpanHandle {
    return this.recorder.startSpan(this.span.runId, kind, name, attributes, this.span.id);
  }

  setAttributes(attributes: Record<string, unknown>): void {
    if (typeof attributes.modelId === 'string') this.span.modelId = attributes.modelId;
    this.span.attributes = safeAttributes({ ...(this.span.attributes ?? {}), ...attributes });
    this.recorder.persistSpan(this.span);
  }

  end(result: TraceSpanEnd = {}): void {
    this.recorder.endSpan(this.span, result, this.root);
  }
}

export class TraceRecorder {
  private readonly runs = new Map<string, TraceRunRecord>();
  private readonly handles = new Map<string, TraceSpanHandle>();
  private readonly rootByRun = new Map<string, TraceSpanHandle>();
  private readonly now: () => Date;
  private readonly onEvent?: (event: TraceEvent) => void;

  constructor(private readonly store: TraceStore, options: TraceRecorderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
  }

  startRun(input: { runId: string; sessionId: string; taskType?: string; complexity?: string }): TraceSpanHandle {
    if (this.runs.has(input.runId)) throw new Error(`Trace run already active: ${input.runId}`);
    const started = this.now();
    const run: TraceRunRecord = {
      id: input.runId,
      sessionId: input.sessionId,
      taskType: input.taskType,
      complexity: input.complexity,
      status: 'running',
      startedAt: started.toISOString(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
    };
    this.runs.set(run.id, run);
    this.store.saveTraceRun(run);
    const root = this.startSpan(run.id, 'run', 'run', { sessionId: input.sessionId, taskType: input.taskType });
    this.rootByRun.set(run.id, root);
    return root;
  }

  startSpan(runId: string, kind: SpanKind, name: string, attributes?: Record<string, unknown>, parentSpanId?: string): TraceSpanHandle {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Trace run not found: ${runId}`);
    const started = this.now();
    const span: TraceSpanRecord = {
      id: randomUUID(),
      runId,
      parentSpanId,
      kind,
      name,
      status: 'running',
      startedAt: started.toISOString(),
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      modelId: typeof attributes?.modelId === 'string' ? attributes.modelId : undefined,
      attributes: safeAttributes(attributes, kind === 'hook' ? 16_384 : MAX_ATTRIBUTES_CHARS),
    };
    this.store.saveTraceSpan(span);
    const handle = new TraceSpanHandle(this, span, kind === 'run');
    this.handles.set(span.id, handle);
    this.emit({ type: 'span_start', runId, span });
    return handle;
  }

  persistSpan(span: TraceSpanRecord): void {
    if (typeof span.attributes?.modelId === 'string') span.modelId = span.attributes.modelId;
    this.store.saveTraceSpan(span);
    const run = this.runs.get(span.runId);
    if (run && span.kind === 'route') {
      if (typeof span.attributes?.taskType === 'string') run.taskType = span.attributes.taskType;
      if (typeof span.attributes?.complexity === 'string') run.complexity = span.attributes.complexity;
      this.store.saveTraceRun(run);
    }
  }

  endSpan(span: TraceSpanRecord, result: TraceSpanEnd, root = false): void {
    if (span.status !== 'running') return;
    const ended = this.now();
    span.endedAt = ended.toISOString();
    span.durationMs = Math.max(0, ended.getTime() - new Date(span.startedAt).getTime());
    span.status = result.status ?? 'success';
    span.inputTokens = result.inputTokens ?? span.inputTokens;
    span.outputTokens = result.outputTokens ?? span.outputTokens;
    span.cost = result.cost ?? span.cost;
    span.errorMessage = result.error;
    if (result.attributes) span.attributes = safeAttributes({ ...(span.attributes ?? {}), ...result.attributes }, span.kind === 'hook' ? 16_384 : MAX_ATTRIBUTES_CHARS);
    this.persistSpan(span);
    this.handles.delete(span.id);
    this.emit({ type: 'span_end', runId: span.runId, span });
    if (!root) return;
    const run = this.runs.get(span.runId);
    if (run) {
      run.totalInputTokens = span.inputTokens || run.totalInputTokens;
      run.totalOutputTokens = span.outputTokens || run.totalOutputTokens;
      run.totalCost = span.cost || run.totalCost;
    }
  }

  finishRun(runId: string, result: TraceRunEnd = {}): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const status = result.status ?? (result.error ? 'failed' : 'success');
    const root = this.rootByRun.get(runId);

    // Close any span left running by an aborted/failed path before closing the root.
    for (const span of [...this.handles.values()].reverse()) {
      if (span.runId === runId && span.id !== root?.id) span.end({ status, error: result.error });
    }
    root?.end({ status, error: result.error, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: result.cost });
    this.rootByRun.delete(runId);

    const ended = this.now();
    run.status = status;
    run.endedAt = ended.toISOString();
    run.durationMs = Math.max(0, ended.getTime() - new Date(run.startedAt).getTime());
    run.errorMessage = result.error;
    if (result.inputTokens !== undefined) run.totalInputTokens = result.inputTokens;
    if (result.outputTokens !== undefined) run.totalOutputTokens = result.outputTokens;
    if (result.cost !== undefined) run.totalCost = result.cost;
    this.store.saveTraceRun(run);
    this.runs.delete(runId);
    this.emit({ type: 'run_end', runId, run });
  }

  getTrace(runId: string): RunTrace | undefined {
    return this.store.getTrace(runId);
  }

  listRecent(sessionId: string, limit = 20): TraceRunRecord[] {
    return this.store.listTraceRuns(sessionId, limit);
  }

  listRecentRuns(limit = 50): TraceRunRecord[] {
    return this.store.listRecentRuns(limit);
  }

  private emit(event: TraceEvent): void {
    try { this.onEvent?.(event); } catch { /* tracing must never fail the run */ }
  }
}

export class InMemoryTraceStore implements TraceStore {
  readonly runs = new Map<string, TraceRunRecord>();
  readonly spans = new Map<string, TraceSpanRecord>();

  saveTraceRun(run: TraceRunRecord): void { this.runs.set(run.id, { ...run }); }
  saveTraceSpan(span: TraceSpanRecord): void { this.spans.set(span.id, { ...span }); }
  getTrace(runId: string): RunTrace | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return {
      run: { ...run },
      spans: [...this.spans.values()].filter((span) => span.runId === runId).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    };
  }
  listTraceRuns(sessionId: string, limit = 20): TraceRunRecord[] {
    return [...this.runs.values()].filter((run) => run.sessionId === sessionId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }
  listRecentRuns(limit = 50): TraceRunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }
}
