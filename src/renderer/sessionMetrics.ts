import type { SessionMetrics } from './types';

export interface SessionRunTiming {
  sessionId: string;
  startedAt: number;
  ttftMs?: number;
  completedAt?: number;
  routeConfidence?: number;
}

type InvocationMetrics = SessionMetrics & { totalCost?: number; latency?: number };

/** Snapshot before updating React state: IPC results and stream events may arrive in either order. */
export function completeSessionMetrics(raw: InvocationMetrics | undefined, timing: SessionRunTiming | undefined, confidence: number | undefined, hasOutput: boolean, now: number): SessionMetrics | undefined {
  if (!raw && !timing && confidence === undefined) return undefined;
  const metrics: SessionMetrics = raw ? {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    latencyMs: raw.latencyMs ?? raw.latency,
    ttftMs: raw.ttftMs,
    cost: raw.cost ?? raw.totalCost,
    routeConfidence: raw.routeConfidence,
    ...(typeof raw.stopReason === 'string' ? { stopReason: raw.stopReason } : {}),
  } : {};
  if (timing) {
    timing.completedAt ??= now;
    // A nonstreamed/faster IPC result can be the first visible output itself.
    if (hasOutput && timing.ttftMs === undefined) timing.ttftMs = Math.max(0, timing.completedAt - timing.startedAt);
    metrics.latencyMs = Math.max(0, timing.completedAt - timing.startedAt);
    metrics.ttftMs = timing.ttftMs ?? metrics.ttftMs;
  }
  metrics.routeConfidence = confidence ?? timing?.routeConfidence ?? metrics.routeConfidence;
  return metrics;
}

export function restoreRouteConfidence(record: { routeConfidence?: unknown; metrics?: unknown }): number | undefined {
  if (typeof record.routeConfidence === 'number') return record.routeConfidence;
  const metrics = record.metrics as SessionMetrics | undefined;
  return typeof metrics?.routeConfidence === 'number' ? metrics.routeConfidence : undefined;
}
