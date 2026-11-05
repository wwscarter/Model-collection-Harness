import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStorage } from '../../src/core/storage/SessionStorage';
import { completeSessionMetrics, restoreRouteConfidence, type SessionRunTiming } from '../../src/renderer/sessionMetrics';

const invocation = { inputTokens: 8036, outputTokens: 73, latency: 61.8, totalCost: 0.08255 };

describe('completed session metrics', () => {
  it('keeps one measured snapshot when the completion event arrives before the invoke result', () => {
    const timing: SessionRunTiming = { sessionId: 'run', startedAt: 100, ttftMs: 65, routeConfidence: 0.98 };
    const eventMetrics = completeSessionMetrics(invocation, timing, 0.98, true, 168);
    const resultMetrics = completeSessionMetrics(invocation, timing, 0.98, true, 172);
    expect(eventMetrics).toEqual({ inputTokens: 8036, outputTokens: 73, latencyMs: 68, ttftMs: 65, cost: 0.08255, routeConfidence: 0.98 });
    expect(resultMetrics).toEqual(eventMetrics);
  });

  it('measures the returned output itself if the invoke result arrives before any stream event', () => {
    const timing: SessionRunTiming = { sessionId: 'run', startedAt: 100 };
    const resultMetrics = completeSessionMetrics(invocation, timing, 0.98, true, 162);
    const lateEventMetrics = completeSessionMetrics(invocation, timing, 0.98, true, 168);
    expect(resultMetrics).toMatchObject({ latencyMs: 62, ttftMs: 62, routeConfidence: 0.98 });
    expect(lateEventMetrics).toEqual(resultMetrics);
  });

  it('does not invent first-output timing for an empty response', () => {
    const timing: SessionRunTiming = { sessionId: 'run', startedAt: 100 };
    expect(completeSessionMetrics(undefined, timing, undefined, false, 168)).toMatchObject({ latencyMs: 68, ttftMs: undefined });
  });

  it('retains metrics from storage without a running renderer timer', () => {
    expect(completeSessionMetrics({ inputTokens: 4, outputTokens: 5, latencyMs: 300, ttftMs: 100, cost: 0.02, routeConfidence: 0.9 }, undefined, undefined, true, 1000))
      .toEqual({ inputTokens: 4, outputTokens: 5, latencyMs: 300, ttftMs: 100, cost: 0.02, routeConfidence: 0.9 });
  });

  it('retains a resource limit reason without changing measured usage', () => {
    expect(completeSessionMetrics({ ...invocation, stopReason: 'tool_limit' }, undefined, undefined, true, 1000))
      .toMatchObject({ inputTokens: 8036, outputTokens: 73, latencyMs: 61.8, cost: 0.08255, stopReason: 'tool_limit' });
  });

  it('keeps budget termination details for partial output and session restoration', () => {
    const budgetLimit = { code: 'BUDGET_EXCEEDED' as const, message: '本轮预估费用达到上限', estimatedCost: 0.301, maxCostUsd: 0.25 };
    expect(completeSessionMetrics({ ...invocation, stopReason: 'budget_limit', budgetLimit }, undefined, undefined, true, 1000))
      .toMatchObject({ inputTokens: 8036, outputTokens: 73, cost: 0.08255, stopReason: 'budget_limit', budgetLimit });
  });

  it('restores measured timing and confidence after closing and reopening session storage', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-session-metrics-'));
    const dbPath = path.join(directory, 'sessions.db');
    const now = new Date('2026-11-03T00:00:00.000Z');
    const metrics = completeSessionMetrics({ ...invocation, stopReason: 'tool_limit' }, { sessionId: 'run', startedAt: 100, ttftMs: 65 }, 0.98, true, 168);
    let storage = new SessionStorage(dbPath);
    try {
      storage.save({ id: 'run', title: 'Test', prompt: '', output: 'Complete', metrics, createdAt: now, updatedAt: now });
      storage.close();
      storage = new SessionStorage(dbPath);
      const restored = storage.list()[0];
      expect(restored.metrics).toEqual(metrics);
      expect(restored.metrics).toMatchObject({ stopReason: 'tool_limit' });
      expect(restoreRouteConfidence(restored)).toBe(0.98);
      expect(restoreRouteConfidence({ routeConfidence: 0.8, metrics })).toBe(0.8);
      expect(restoreRouteConfidence({ metrics: { cost: 1 } })).toBeUndefined();
    } finally {
      storage.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
