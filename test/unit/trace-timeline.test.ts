// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceTimeline } from '../../src/renderer/components/TraceTimeline';
import { traceModelCallSpans, traceProblemCounts, traceRunUsage, traceSpanUsage, traceTiming, traceTree } from '../../src/renderer/tracePresentation';
import type { RunTrace, TraceSpan } from '../../src/renderer/types';

const at = (ms: number) => new Date(Date.parse('2026-11-11T00:00:00Z') + ms).toISOString();
const span = (id: string, kind: TraceSpan['kind'], parentSpanId?: string, startedAt = at(0)): TraceSpan => ({ id, runId: 'run-1', name: id, kind, parentSpanId, startedAt, status: 'success', durationMs: 100, inputTokens: 0, outputTokens: 0, cost: 0 });
const trace = (spans: TraceSpan[]): RunTrace => ({ run: { id: 'run-1', sessionId: 's', startedAt: at(0), status: 'success', durationMs: 1000, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 }, spans });
let container: HTMLDivElement;
let root: Root;
const render = async (value: RunTrace) => { await act(async () => { root.render(createElement(TraceTimeline, { trace: value, defaultOpen: true })); }); };
const clickFilter = async (label: string) => { await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('.trace-toolbar button')].find((button) => button.textContent === label)!.click(); }); };
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('trace usage and failure semantics', () => {
  it('keeps zero run totals authoritative instead of summing aggregate roots and children', async () => {
    const value = trace([{ ...span('root', 'run'), inputTokens: 10, outputTokens: 5, cost: .02 }, { ...span('model', 'model', 'root'), inputTokens: 10, outputTokens: 5, cost: .02 }]);
    expect(traceRunUsage(value)).toEqual({ state: 'recorded', inputTokens: 0, outputTokens: 0, cost: 0 });
    await render(value);
    expect(container.querySelector('.trace-summary-right')!.textContent).toContain('0 tok');
    expect(container.querySelector('.trace-summary-right')!.textContent).toContain('$0.0000');
    expect(container.querySelector('.trace-summary-right')!.textContent).not.toContain('30 tok');
  });

  it('distinguishes successful zero usage, absent failed usage, running usage and non-model steps', () => {
    const value = trace([span('model', 'model')]);
    expect(traceRunUsage(value).state).toBe('recorded');
    expect(traceSpanUsage(value.spans[0])).toMatchObject({ state: 'recorded', inputTokens: 0, cost: 0 });
    value.run.status = 'failed'; value.spans[0].status = 'failed';
    expect(traceRunUsage(value)).toEqual({ state: 'unrecorded' });
    expect(traceSpanUsage(value.spans[0])).toEqual({ state: 'unrecorded' });
    value.run.status = 'running'; value.spans[0].status = 'running';
    expect(traceRunUsage(value)).toEqual({ state: 'pending' });
    expect(traceSpanUsage(value.spans[0])).toEqual({ state: 'pending' });
    expect(traceSpanUsage(span('route', 'route'))).toBeUndefined();
  });

  it('counts terminal failed and cancelled steps without repeating the root outcome', async () => {
    const value = trace([
      { ...span('root', 'run'), status: 'failed' },
      { ...span('plan', 'plan', 'root'), status: 'failed' },
      { ...span('model', 'model', 'plan'), status: 'failed' },
      { ...span('cancelled-tool', 'tool', 'root'), status: 'cancelled' },
    ]);
    value.run.status = 'failed';
    expect(traceProblemCounts(value)).toEqual({ failedSteps: 1, cancelledSteps: 1 });
    await render(value);
    expect(container.querySelector('.trace-summary-copy')!.textContent).toContain('1 个失败步骤');
    expect(container.querySelector('.trace-summary-copy')!.textContent).toContain('1 个取消步骤');
    expect(container.querySelector('[data-span-id="model"]')!.textContent).toContain('未记录');
  });
});

describe('trace hierarchy and waterfall', () => {
  it('includes utility model stages without mistaking route and static-audit references for calls', async () => {
    const value = trace([span('root', 'run'), span('executor', 'model', 'root'), { ...span('review', 'audit', 'root'), name: 'model-verify' }, { ...span('extract', 'memory', 'root'), name: 'memory.extract' }, { ...span('static', 'audit', 'root'), name: 'static-audit' }, span('route', 'route', 'root')]);
    expect(traceModelCallSpans(value).map((item) => item.id)).toEqual(['executor', 'review', 'extract']);
    expect(traceSpanUsage(value.spans[4])).toBeUndefined();
    await render(value);
    expect(container.querySelector('.trace-summary-copy')!.textContent).toContain('3 个模型阶段');
    await clickFilter('模型');
    expect([...container.querySelectorAll('.trace-row')].map((row) => row.getAttribute('data-span-id'))).toEqual(['root', 'executor', 'review', 'extract']);
  });

  it('keeps parent context under filters and restores all steps when clearing the filter', async () => {
    const value = trace([span('root', 'run'), span('route', 'route', 'root'), span('executor', 'model', 'root'), span('read', 'tool', 'executor')]);
    await render(value);
    expect(container.querySelector('.trace-column-head')!.textContent).toContain('相对时间');
    await clickFilter('工具');
    expect([...container.querySelectorAll('.trace-row')].map((row) => row.getAttribute('data-span-id'))).toEqual(['root', 'executor', 'read']);
    expect(container.querySelector('[data-span-id="read"]')!.getAttribute('data-depth')).toBe('2');
    await clickFilter('全部');
    expect(container.querySelectorAll('.trace-row')).toHaveLength(4);
    await clickFilter('异常');
    expect(container.querySelector('.trace-empty')!.textContent).toContain('没有符合当前筛选条件');
  });

  it('retains orphaned history and safely handles parent cycles under filters', async () => {
    const value = trace([span('orphan', 'tool', 'missing'), span('cycle-a', 'model', 'cycle-b'), span('cycle-b', 'plan', 'cycle-a')]);
    expect(traceTree(value.spans).rows).toHaveLength(3);
    await render(value);
    expect(container.querySelectorAll('.trace-row')).toHaveLength(3);
    expect(container.querySelector('[data-span-id="orphan"]')!.textContent).toContain('独立节点');
    await clickFilter('模型');
    expect(container.querySelectorAll('.trace-row')).toHaveLength(2);
    expect(traceProblemCounts(value)).toEqual({ failedSteps: 0, cancelledSteps: 0 });
  });

  it('positions child bars against the run start even when the root span is absent', async () => {
    const value = trace([span('late-model', 'model', undefined, at(500))]);
    value.spans[0].durationMs = 250;
    expect(traceTiming(value)).toMatchObject({ start: Date.parse(at(0)), duration: 1000 });
    await render(value);
    const bar = container.querySelector<HTMLElement>('.trace-waterfall i')!;
    expect(bar.style.left).toBe('50%');
    expect(bar.style.width).toBe('25%');
    expect(container.querySelector('.trace-offset')!.textContent).toBe('+500ms');
  });

  it('derives live timing without treating an unfinished run as zero duration', () => {
    const value = trace([span('live', 'model', undefined, at(500))]);
    value.run.status = 'running'; delete value.run.durationMs;
    value.spans[0].status = 'running'; delete value.spans[0].durationMs;
    expect(traceTiming(value, Date.parse(at(2000)))).toMatchObject({ duration: 2000, runDuration: 2000 });
  });

  it('clears expanded details when switching runs so a reused span ID does not leak selection', async () => {
    const value = trace([span('model', 'model')]);
    await render(value);
    await act(async () => { container.querySelector<HTMLButtonElement>('.trace-row')!.click(); });
    expect(container.querySelector('.trace-detail')).not.toBeNull();
    const next = trace([span('model', 'model')]); next.run.id = 'run-2';
    await render(next);
    expect(container.querySelector('.trace-detail')).toBeNull();
  });
});
