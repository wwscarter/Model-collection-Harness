export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled';
export type SpanStatus = 'running' | 'success' | 'failed' | 'cancelled';
export type SpanKind = 'run' | 'route' | 'context' | 'memory' | 'compact' | 'plan' | 'model' | 'tool' | 'synthesis' | 'audit' | 'verify' | 'verify-command' | 'verify-repair';

export interface TraceRunRecord {
  id: string;
  sessionId: string;
  taskType?: string;
  complexity?: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  errorMessage?: string;
}

export interface TraceSpanRecord {
  id: string;
  runId: string;
  parentSpanId?: string;
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  attributes?: Record<string, unknown>;
  errorMessage?: string;
}

export interface RunTrace {
  run: TraceRunRecord;
  spans: TraceSpanRecord[];
}

export interface TraceStore {
  saveTraceRun(run: TraceRunRecord): void;
  saveTraceSpan(span: TraceSpanRecord): void;
  getTrace(runId: string): RunTrace | undefined;
  listTraceRuns(sessionId: string, limit?: number): TraceRunRecord[];
  listRecentRuns(limit?: number): TraceRunRecord[];
}

export interface TraceEvent {
  type: 'span_start' | 'span_end' | 'run_end';
  runId: string;
  span?: TraceSpanRecord;
  run?: TraceRunRecord;
}
