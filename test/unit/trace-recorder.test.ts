import { describe, expect, it } from 'vitest';
import { InMemoryTraceStore, TraceRecorder } from '../../src/core/trace/TraceRecorder';
import { ObservabilityEngine } from '../../src/core/observability/ObservabilityEngine';

function clock() {
  let value = Date.parse('2026-11-04T00:00:00.000Z');
  return () => new Date(value += 10);
}

describe('TraceRecorder', () => {
  it('uses the same default completion status for the run and its unfinished spans', () => {
    const store = new InMemoryTraceStore();
    const recorder = new TraceRecorder(store, { now: clock() });
    recorder.startRun({ runId: 'default-success', sessionId: 's' }).child('tool', 'read');
    recorder.finishRun('default-success');
    expect(recorder.getTrace('default-success')?.run.status).toBe('success');
    expect(recorder.getTrace('default-success')?.spans.every((span) => span.status === 'success')).toBe(true);
    recorder.startRun({ runId: 'default-failure', sessionId: 's' }).child('model', 'executor');
    recorder.finishRun('default-failure', { error: 'network unavailable' });
    expect(recorder.getTrace('default-failure')?.run.status).toBe('failed');
    expect(recorder.getTrace('default-failure')?.spans.every((span) => span.status === 'failed' && span.errorMessage === 'network unavailable')).toBe(true);
  });

  it('retains routed metadata and final totals on the exported trace', () => {
    const recorder = new TraceRecorder(new InMemoryTraceStore(), { now: clock() });
    const root = recorder.startRun({ runId: 'metadata', sessionId: 's', taskType: 'general' });
    const route = root.child('route', 'route');
    route.end({ attributes: { modelId: 'first', taskType: 'code', complexity: 'high' } });
    route.setAttributes({ modelId: 'final' });
    root.child('model', 'executor', { modelId: 'final' }).end();
    recorder.finishRun('metadata', { inputTokens: 21, outputTokens: 8, cost: 0.123 });
    const trace = recorder.getTrace('metadata')!;
    expect(trace.run).toMatchObject({ taskType: 'code', complexity: 'high', totalInputTokens: 21, totalOutputTokens: 8, totalCost: 0.123 });
    expect(trace.spans.find((span) => span.kind === 'run')).toMatchObject({ status: 'success', inputTokens: 21, outputTokens: 8, cost: 0.123 });
    expect(trace.spans.filter((span) => span.kind === 'model' || span.kind === 'route').every((span) => span.modelId === 'final')).toBe(true);
  });

  it('settles a run once and rejects late children after releasing its active state', () => {
    const events: string[] = [];
    const recorder = new TraceRecorder(new InMemoryTraceStore(), { now: clock(), onEvent: (event) => events.push(event.type) });
    const root = recorder.startRun({ runId: 'finished', sessionId: 's' });
    recorder.finishRun('finished');
    recorder.finishRun('finished', { status: 'failed' });
    expect(events.filter((event) => event === 'run_end')).toHaveLength(1);
    expect(recorder.getTrace('finished')?.run.status).toBe('success');
    expect(() => root.child('tool', 'late')).toThrow('Trace run not found');
  });

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

  it('preserves structured model identity when other attributes exceed the cap and detaches caller objects', () => {
    const recorder = new TraceRecorder(new InMemoryTraceStore(), { now: clock() });
    const root = recorder.startRun({ runId: 'identity-bounds', sessionId: 's' });
    const modelSnapshot = { configurationId: 'legacy-id', modelId: 'actual-model', name: 'Current model', provider: 'custom', costPer1kTokens: { input: 0.1, output: 0.2 }, configurationUpdatedAt: '2026-11-05T00:00:00Z' };
    const span = root.child('model', 'execution', { modelId: 'legacy-id', modelSnapshot, notes: '"'.repeat(10000) });
    modelSnapshot.modelId = 'mutated-after-recording';
    modelSnapshot.costPer1kTokens.input = 99;
    span.end({ attributes: { stopReason: 'stop' } });
    recorder.finishRun('identity-bounds');
    const saved = recorder.getTrace('identity-bounds')?.spans.find((item) => item.id === span.id)!;
    expect(saved.attributes).toMatchObject({ truncated: true, modelId: 'legacy-id', modelSnapshot: { modelId: 'actual-model', costPer1kTokens: { input: 0.1 } } });
    expect(JSON.stringify(saved.attributes).length).toBeLessThanOrEqual(4000);
  });
});

describe('TraceStore', () => {
  it('keeps active traces intact when pruning or clearing completed history', () => {
    const engine = new ObservabilityEngine();
    const recorder = new TraceRecorder(engine, { now: clock() });
    const active = recorder.startRun({ runId: 'active', sessionId: 's' });
    active.child('tool', 'read');
    recorder.startRun({ runId: 'done', sessionId: 's' });
    recorder.finishRun('done');
    try {
      expect(engine.pruneTraces({ maxAgeDays: 1, now: new Date('2026-12-01') }).runs).toBe(1);
      expect(engine.getTrace('active')?.spans).toHaveLength(2);
      expect(engine.clearTraces()).toEqual({ runs: 0, spans: 0 });
      recorder.finishRun('active');
      expect(engine.clearTraces()).toEqual({ runs: 1, spans: 2 });
    } finally { engine.close(); }
  });

  it('settles interrupted runs on restart while preserving completed spans', () => {
    const engine = new ObservabilityEngine();
    const recorder = new TraceRecorder(engine, { now: clock() });
    const root = recorder.startRun({ runId: 'interrupted', sessionId: 's' });
    root.child('route', 'route').end();
    root.child('model', 'executor');
    try {
      expect(engine.recoverInterruptedRuns(new Date('2026-11-04T00:01:00.000Z'))).toBe(1);
      const trace = engine.getTrace('interrupted')!;
      expect(trace.run).toMatchObject({ status: 'cancelled', endedAt: '2026-11-04T00:01:00.000Z' });
      expect(trace.spans.find((span) => span.kind === 'route')?.status).toBe('success');
      expect(trace.spans.find((span) => span.kind === 'model')?.status).toBe('cancelled');
      expect(engine.recoverInterruptedRuns()).toBe(0);
    } finally { engine.close(); }
  });

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
    expect(engine.getTraceRetention()).toEqual({ maxAgeDays: 30, maxRuns: 1_000 });
    expect(engine.setTraceRetention({ maxAgeDays: 7, maxRuns: 200 })).toEqual({ maxAgeDays: 7, maxRuns: 200 });
    expect(engine.getTraceRetention()).toEqual({ maxAgeDays: 7, maxRuns: 200 });
    expect(engine.clearTraces()).toEqual({ runs: 1, spans: 0 });
    engine.close();
  });
});
