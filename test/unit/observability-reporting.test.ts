import { describe, expect, it } from 'vitest';
import { ObservabilityEngine } from '../../src/core/observability/ObservabilityEngine';

function invocation(engine: ObservabilityEngine, taskId: string, modelId: string, input = 100, output = 20) {
  const id = engine.recordInvocationStart(taskId, modelId);
  return engine.recordInvocationEnd(id, input, output, { input: 0.01, output: 0.02 });
}

describe('observability reporting', () => {
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
