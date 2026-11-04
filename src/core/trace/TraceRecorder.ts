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
function safeAttributes(attributes: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attributes) return undefined;
  try {
    const json = JSON.stringify(attributes);
    if (json.length <= MAX_ATTRIBUTES_CHARS) return attributes;
    return { truncated: true, preview: json.slice(0, MAX_ATTRIBUTES_CHARS - 128) };
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
  private readonly finished = new Set<string>();
  private readonly now: () => Date;
  private readonly onEvent?: (event: TraceEvent) => void;

  constructor(private readonly store: TraceStore, options: TraceRecorderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
  }

  startRun(input: { runId: string; sessionId: string; taskType?: string; complexity?: string }): TraceSpanHandle {
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
      attributes: safeAttributes(attributes),
    };
    this.store.saveTraceSpan(span);
    const handle = new TraceSpanHandle(this, span);
    this.handles.set(span.id, handle);
    this.emit({ type: 'span_start', runId, span });
    return handle;
  }

  persistSpan(span: TraceSpanRecord): void {
    this.store.saveTraceSpan(span);
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
    if (result.attributes) span.attributes = safeAttributes({ ...(span.attributes ?? {}), ...result.attributes });
    this.store.saveTraceSpan(span);
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
    if (this.finished.has(runId)) return;
    this.finished.add(runId);
    const run = this.runs.get(runId);
    if (!run) return;

    // Close any span left running by an aborted/failed path before closing the root.
    for (const span of [...this.handles.values()].reverse()) {
      if (span.runId === runId) span.end({ status: result.status === 'success' ? 'success' : (result.status ?? 'cancelled') });
    }
    const root = this.rootByRun.get(runId);
    root?.end({ status: result.status === 'success' ? 'success' : (result.status ?? 'cancelled'), error: result.error });
    this.rootByRun.delete(runId);

    const ended = this.now();
    run.status = result.status ?? (result.error ? 'failed' : 'success');
    run.endedAt = ended.toISOString();
    run.durationMs = Math.max(0, ended.getTime() - new Date(run.startedAt).getTime());
    run.errorMessage = result.error;
    if (result.inputTokens !== undefined) run.totalInputTokens = result.inputTokens;
    if (result.outputTokens !== undefined) run.totalOutputTokens = result.outputTokens;
    if (result.cost !== undefined) run.totalCost = result.cost;
    this.store.saveTraceRun(run);
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
