import type { RunTrace, TraceSpan } from './types';

const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
const timestamp = (value?: string) => value ? Date.parse(value) : Number.NaN;
const problem = (span: TraceSpan) => span.status === 'failed' || span.status === 'cancelled';

export interface TraceTreeRow {
  span: TraceSpan;
  depth: number;
  detached: boolean;
}

/** Keep partial historical traces reachable, including missing parents and cycles. */
export function traceTree(spans: TraceSpan[]) {
  const sorted = [...spans].sort((a, b) => {
    const first = timestamp(a.startedAt), second = timestamp(b.startedAt);
    return Number.isFinite(first) && Number.isFinite(second) ? first - second : 0;
  });
  const byId = new Map(sorted.map((span) => [span.id, span]));
  const children = new Map<string, TraceSpan[]>();
  for (const span of sorted) {
    if (!span.parentSpanId || !byId.has(span.parentSpanId) || span.parentSpanId === span.id) continue;
    const siblings = children.get(span.parentSpanId) ?? [];
    siblings.push(span);
    children.set(span.parentSpanId, siblings);
  }
  const rows: TraceTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (span: TraceSpan, depth: number, detached: boolean) => {
    if (visited.has(span.id)) return;
    visited.add(span.id);
    rows.push({ span, depth, detached });
    for (const child of children.get(span.id) ?? []) visit(child, depth + 1, false);
  };
  for (const span of sorted) {
    if (!span.parentSpanId || !byId.has(span.parentSpanId) || span.parentSpanId === span.id) visit(span, 0, Boolean(span.parentSpanId));
  }
  // A corrupt parent cycle should not hide the rest of a trace or hang filtering.
  for (const span of sorted) if (!visited.has(span.id)) visit(span, 0, true);
  return { rows, sorted, byId, children };
}

export function traceProblemCounts(trace: RunTrace) {
  const { children } = traceTree(trace.spans);
  const terminal = trace.spans.filter((span) => {
    if (span.kind === 'run' || !problem(span)) return false;
    const visited = new Set([span.id]);
    const descendants = [...(children.get(span.id) ?? [])];
    while (descendants.length) {
      const child = descendants.pop()!;
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      if (problem(child)) return false;
      descendants.push(...(children.get(child.id) ?? []));
    }
    return true;
  });
  return { failedSteps: terminal.filter((span) => span.status === 'failed').length, cancelledSteps: terminal.filter((span) => span.status === 'cancelled').length };
}

export interface TraceUsage {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  state: 'recorded' | 'pending' | 'unrecorded';
}

/** These spans describe model stages, not individual transport requests. */
export function traceModelCallSpans(trace: RunTrace): TraceSpan[] {
  return trace.spans.filter((span) => span.kind === 'model' || (span.kind === 'audit' && span.name === 'model-verify') || (span.kind === 'memory' && span.name === 'memory.extract'));
}

/** Run totals are authoritative. Summing root and child spans double counts usage. */
export function traceRunUsage(trace: RunTrace): TraceUsage {
  const { run, spans } = trace;
  const hasValues = run.totalInputTokens > 0 || run.totalOutputTokens > 0 || run.totalCost > 0;
  const modelAttempted = traceModelCallSpans(trace).length > 0 || spans.some((span) => span.inputTokens > 0 || span.outputTokens > 0 || span.cost > 0);
  if (!hasValues && run.status === 'running') return { state: 'pending' };
  if (!hasValues && modelAttempted && (run.status === 'failed' || run.status === 'cancelled')) return { state: 'unrecorded' };
  return {
    inputTokens: finite(run.totalInputTokens) ? run.totalInputTokens : undefined,
    outputTokens: finite(run.totalOutputTokens) ? run.totalOutputTokens : undefined,
    cost: finite(run.totalCost) ? run.totalCost : undefined,
    state: 'recorded',
  };
}

export function traceSpanUsage(span: TraceSpan): TraceUsage | undefined {
  const hasValues = span.inputTokens > 0 || span.outputTokens > 0 || span.cost > 0;
  const producesUsage = span.kind === 'model' || hasValues || (span.kind === 'audit' && span.name === 'model-verify') || (span.kind === 'memory' && span.name === 'memory.extract');
  if (!producesUsage) return undefined;
  if (!hasValues && span.status === 'running') return { state: 'pending' };
  if (!hasValues && (span.status === 'failed' || span.status === 'cancelled')) return { state: 'unrecorded' };
  return { inputTokens: finite(span.inputTokens) ? span.inputTokens : undefined, outputTokens: finite(span.outputTokens) ? span.outputTokens : undefined, cost: finite(span.cost) ? span.cost : undefined, state: 'recorded' };
}

export function traceDuration(record: { durationMs?: number; startedAt: string; endedAt?: string; status: string }, now = Date.now()): number | undefined {
  if (finite(record.durationMs)) return record.durationMs;
  const start = timestamp(record.startedAt);
  const end = record.status === 'running' ? now : timestamp(record.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

export function traceTiming(trace: RunTrace, now = Date.now()) {
  const starts = [timestamp(trace.run.startedAt), ...trace.spans.map((span) => timestamp(span.startedAt))].filter(Number.isFinite);
  const start = starts.length ? Math.min(...starts) : 0;
  const ends = trace.spans.flatMap((span) => {
    const spanStart = timestamp(span.startedAt), length = traceDuration(span, now);
    return Number.isFinite(spanStart) && length !== undefined ? [spanStart + length] : [];
  });
  const length = traceDuration(trace.run, now);
  if (length !== undefined && Number.isFinite(timestamp(trace.run.startedAt))) ends.push(timestamp(trace.run.startedAt) + length);
  const end = ends.length ? Math.max(start, ...ends) : start;
  return { start, duration: Math.max(0, end - start), runDuration: length };
}
