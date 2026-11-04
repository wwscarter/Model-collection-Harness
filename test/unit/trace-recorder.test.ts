import { describe, expect, it } from 'vitest';
import { InMemoryTraceStore, TraceRecorder } from '../../src/core/trace/TraceRecorder';
import { ObservabilityEngine } from '../../src/core/observability/ObservabilityEngine';

function clock() {
  let value = Date.parse('2026-11-04T00:00:00.000Z');
  return () => new Date(value += 10);
}

describe('TraceRecorder', () => {
  it('records a nested run tree with timings and totals', () => {
    const store = new InMemoryTraceStore();
    const recorder = new TraceRecorder(store, { now: clock() });
    const run = recorder.startRun({ runId: 'run-1', sessionId: 'session-1', taskType: 'code', complexity: 'high' });
    const route = run.child('route', 'route');
    route.end({ attributes: { modelId: 'model-a' } });
    const plan = run.child('plan', 'planning');
    const planner = plan.child('model', 'planner', { modelId: 'model-b' });
    planner.end({ inputTokens: 10, outputTokens: 5, cost: 0.001 });
    plan.end();
    const execution = run.child('model', 'executor', { modelId: 'model-a' });
    const tool = execution.child('tool', 'read');
    tool.end({ attributes: { path: 'src/a.ts' } });
    execution.end({ inputTokens: 20, outputTokens: 8, cost: 0.002 });
    recorder.finishRun('run-1', { status: 'success', inputTokens: 30, outputTokens: 13, cost: 0.003 });

    const trace = recorder.getTrace('run-1');
    expect(trace?.run).toMatchObject({ status: 'success', totalInputTokens: 30, totalOutputTokens: 13, totalCost: 0.003 });
    expect(trace?.spans).toHaveLength(6);
    const byName = new Map(trace?.spans.map((span) => [span.name, span]));
    expect(byName.get('route')?.parentSpanId).toBe(trace?.spans.find((span) => span.kind === 'run')?.id);
    expect(byName.get('planner')?.parentSpanId).toBe(byName.get('planning')?.id);
    expect(byName.get('read')?.parentSpanId).toBe(byName.get('executor')?.id);
    expect(byName.get('executor')?.durationMs).toBeGreaterThan(0);
    expect(recorder.listRecent('session-1')).toHaveLength(1);
  });

  it('closes spans left running when a run ends and marks the root status', () => {
    const store = new InMemoryTraceStore();
    const recorder = new TraceRecorder(store, { now: clock() });
    const run = recorder.startRun({ runId: 'run-2', sessionId: 'session-2' });
    const hanging = run.child('tool', 'read');
    recorder.finishRun('run-2', { status: 'cancelled', error: '任务已取消' });

    const trace = recorder.getTrace('run-2');
    expect(trace?.run.status).toBe('cancelled');
    expect(trace?.run.errorMessage).toBe('任务已取消');
    const root = trace?.spans.find((span) => span.kind === 'run');
    const tool = trace?.spans.find((span) => span.id === hanging.id);
    expect(root?.status).toBe('cancelled');
    expect(tool?.status).toBe('cancelled');
    expect(trace?.spans.every((span) => span.endedAt)).toBe(true);
  });

  it('bounds unbounded trace attributes and emits live events', () => {
    const store = new InMemoryTraceStore();
    const events: string[] = [];
    const recorder = new TraceRecorder(store, { now: clock(), onEvent: (event) => events.push(event.type) });
    const run = recorder.startRun({ runId: 'run-3', sessionId: 'session-3' });
    const span = run.child('tool', 'read', { content: 'x'.repeat(10_000) });
    span.end();
    recorder.finishRun('run-3');
    const tool = recorder.getTrace('run-3')?.spans.find((item) => item.id === span.id);
    expect(tool?.attributes).toMatchObject({ truncated: true });
    expect(JSON.stringify(tool?.attributes).length).toBeLessThanOrEqual(4_000);
    expect(events).toContain('span_start');
    expect(events).toContain('run_end');
  });
});

describe('TraceStore', () => {
  it('persists and reads runs and spans through the metrics database', () => {
    const engine = new ObservabilityEngine();
    engine.saveTraceRun({
      id: 'run-db', sessionId: 'session-db', taskType: 'code', complexity: 'medium', status: 'success',
      startedAt: '2026-11-04T00:00:00.000Z', endedAt: '2026-11-04T00:00:01.000Z', durationMs: 1000,
      totalInputTokens: 100, totalOutputTokens: 20, totalCost: 0.01,
    });
    engine.saveTraceSpan({
      id: 'span-db', runId: 'run-db', kind: 'model', name: 'executor', status: 'success',
      startedAt: '2026-11-04T00:00:00.000Z', endedAt: '2026-11-04T00:00:01.000Z', durationMs: 1000,
      modelId: 'model-a', inputTokens: 100, outputTokens: 20, cost: 0.01, attributes: { role: 'executor' },
    });
    expect(engine.getTrace('run-db')).toMatchObject({
      run: { id: 'run-db', status: 'success' },
      spans: [{ id: 'span-db', attributes: { role: 'executor' } }],
    });
    expect(engine.getTrace('missing')).toBeUndefined();
    expect(engine.listTraceRuns('session-db')).toHaveLength(1);
    engine.close();
  });

  it('prunes old runs and their spans', () => {
    const engine = new ObservabilityEngine();
    const base = { sessionId: 's', status: 'success' as const, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 };
    engine.saveTraceRun({ ...base, id: 'old', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z' });
    engine.saveTraceSpan({ id: 'old-span', runId: 'old', kind: 'model', name: 'old', status: 'success', startedAt: '2026-01-01T00:00:00.000Z', inputTokens: 0, outputTokens: 0, cost: 0 });
    engine.saveTraceRun({ ...base, id: 'new', startedAt: '2026-11-04T00:00:00.000Z', endedAt: '2026-11-04T00:00:01.000Z' });
    expect(engine.pruneTraces({ maxAgeDays: 1, maxRuns: 10, now: new Date('2026-11-04T12:00:00.000Z') })).toEqual({ runs: 1, spans: 1 });
    expect(engine.getTrace('old')).toBeUndefined();
    expect(engine.getTrace('new')).toBeDefined();
    engine.close();
  });
});
