import { describe, expect, it, vi } from 'vitest';
import { ObservabilityEngine } from '../../src/core/observability/ObservabilityEngine';

function invocation(engine: ObservabilityEngine, taskId: string, modelId: string, input = 100, output = 20) {
  const id = engine.recordInvocationStart(taskId, modelId);
  return engine.recordInvocationEnd(id, input, output, { input: 0.01, output: 0.02 });
}

describe('observability reporting', () => {
  it('aggregates model usage, UTC buckets and recent records within the requested range', () => {
    vi.useFakeTimers();
    const engine = new ObservabilityEngine();
    try {
      vi.setSystemTime(new Date('2026-11-04T10:00:00.000Z'));
      invocation(engine, 'task-a', 'model-a', 100, 20);
      vi.setSystemTime(new Date('2026-11-04T11:00:00.000Z'));
      invocation(engine, 'task-a', 'model-a', 50, 10);
      vi.setSystemTime(new Date('2026-11-05T09:00:00.000Z'));
      invocation(engine, 'task-b', 'model-b', 30, 6);
      expect(engine.getSummary()).toMatchObject({ totalInvocations: 3, totalTasks: 2, totalTokens: 216, successRate: 1 });
      expect(engine.getModelTokenUsage('model-a')).toBe(180);
      expect(engine.getModelTokenUsage('model-a', { from: '2026-11-04T11:00:00.000Z' })).toBe(60);
      expect(engine.getModelTokenUsage('missing')).toBe(0);
      expect(engine.getModelMetrics()[0]).toMatchObject({ modelId: 'model-a', invocations: 2, totalTokens: 180, share: 2 / 3 });
      expect(engine.getCostTrend().map((point) => point.bucket)).toEqual(['2026-11-04', '2026-11-05']);
      expect(engine.getCostTrend({}, 'hour')).toHaveLength(3);
      expect(engine.getReport({}, 1).recent.map((entry) => entry.modelId)).toEqual(['model-b']);
      const past = engine.getReport({ to: '2026-11-04T11:00:00.000Z' }, 1);
      expect(past.summary.totalTokens).toBe(180);
      expect(past.recent[0].inputTokens).toBe(50);
    } finally { engine.close(); vi.useRealTimers(); }
  });

  it('returns finite empty aggregates without loading invocation history', () => {
    const engine = new ObservabilityEngine();
    try {
      expect(engine.getSummary()).toEqual({ totalInvocations: 0, totalTasks: 0, totalTokens: 0, totalCost: 0, successRate: 0, avgLatency: 0, auditCount: 0, auditPassRate: 0 });
      expect(engine.getModelMetrics()).toEqual([]);
      expect(engine.getCostTrend()).toEqual([]);
      expect(engine.getReport().recent).toEqual([]);
    } finally { engine.close(); }
  });

  it('aggregates dashboard data by model and cost bucket', () => {
    const engine = new ObservabilityEngine();
    invocation(engine, 'task-a', 'model-a');
    invocation(engine, 'task-b', 'model-a', 50, 10);
    const failed = engine.recordInvocationStart('task-c', 'model-b');
    engine.recordInvocationEnd(failed, 10, 0, { input: 0.01, output: 0.02 }, 'failure', 'network');
    engine.recordAuditResult({ taskId: 'task-a', modelId: 'model-a', approved: true, score: 94 });
    engine.recordAuditResult({ taskId: 'task-c', modelId: 'model-b', approved: false, score: 40 });

    const snapshot = engine.getDashboardSnapshot();
    expect(snapshot.summary).toMatchObject({ totalInvocations: 3, totalTasks: 3, auditCount: 2, auditPassRate: 0.5 });
    expect(snapshot.modelUsage[0]).toMatchObject({ modelId: 'model-a', invocations: 2, successRate: 1 });
    expect(snapshot.costTrend).toHaveLength(1);
    expect(engine.getReportMarkdown()).toContain('AMD Agent Observability Report');
    engine.close();
  });

  it('filters reports by inclusive ISO date ranges', () => {
    const engine = new ObservabilityEngine();
    const result = invocation(engine, 'task-a', 'model-a');
    const from = new Date(result!.startTime.getTime() - 1);
    const to = new Date(result!.endTime!.getTime() + 1);
    expect(engine.getDashboardSnapshot({ from, to }).summary.totalInvocations).toBe(1);
    expect(() => engine.getDashboardSnapshot({ from: 'not-a-date' })).toThrow('Invalid metrics date');
    engine.close();
  });
});
