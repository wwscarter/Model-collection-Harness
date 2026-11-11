// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitoringPage } from '../../src/renderer/pages/MonitoringPage';
import { RunHistoryPage } from '../../src/renderer/pages/RunHistoryPage';
import type { AmdApi, RunTrace, TraceRun } from '../../src/renderer/types';

let container: HTMLDivElement;
let root: Root;
const now = Date.now();
const run = (id: string, status: TraceRun['status'] = 'success', ageDays = 0): TraceRun => ({ id, sessionId: 'session-' + id, taskType: 'analysis', status, startedAt: new Date(now - ageDays * 86_400_000).toISOString(), durationMs: 100, totalInputTokens: 10, totalOutputTokens: 5, totalCost: 0.0123 });
const trace = (value: TraceRun): RunTrace => ({ run: value, spans: [] });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; };
const render = async (element: React.ReactNode) => { await act(async () => { root.render(element); }); };
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)!;
const click = async (item: HTMLElement) => { await act(async () => { item.click(); }); };
const changeSelect = async (name: string, value: string) => { await act(async () => { const element = container.querySelector<HTMLSelectElement>('[aria-label="' + name + '"]')!; element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }); };
const search = async (value: string) => { await act(async () => { const element = container.querySelector<HTMLInputElement>('[aria-label="搜索运行记录"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }); };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  window.amd = {
    getDashboard: vi.fn(async () => ({ range: { from: new Date(now - 7 * 86_400_000).toISOString(), to: new Date(now).toISOString() }, summary: { totalTasks: 87, totalInvocations: 100, totalCost: 1, successRate: 0.9, avgLatency: 300 }, modelUsage: [], costTrend: [], recent: [] })),
    trace: { list: vi.fn(async () => [run('latest'), run('previous', 'failed', 2)]), get: vi.fn(async (id: string) => trace(run(id))) },
  } as unknown as AmdApi;
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); delete window.amd; vi.restoreAllMocks(); });

describe('overview and history page separation', () => {
  it('keeps dashboard aggregates independent of the bounded trace list and provides a history entry', async () => {
    const onOpenRuns = vi.fn();
    await render(createElement(MonitoringPage, { onOpenRuns }));
    expect(container.querySelector('.monitoring-metrics strong')!.textContent).toBe('87');
    expect(window.amd!.trace.list).not.toHaveBeenCalled();
    expect(container.querySelector('.monitoring-trace')).toBeNull();
    expect(container.textContent).not.toContain('最近 2 轮');
    await click(button('查看运行记录与调用链'));
    expect(onOpenRuns).toHaveBeenCalledOnce();
  });

  it('composes range, status and search filters and clears all of them together', async () => {
    vi.mocked(window.amd!.trace.list).mockResolvedValue([run('failed-today', 'failed'), run('success-today'), run('failed-old', 'failed', 3)]);
    await render(createElement(RunHistoryPage));
    expect(window.amd!.trace.list).toHaveBeenCalledWith(50);
    expect(container.textContent).toContain('最多读取最近 50 轮');
    await changeSelect('运行记录状态', 'failed');
    expect(container.querySelectorAll('.monitoring-run-row')).toHaveLength(2);
    await changeSelect('运行记录时间范围', '24h');
    expect(container.querySelectorAll('.monitoring-run-row')).toHaveLength(1);
    expect(container.querySelector('.monitoring-run-row')!.getAttribute('aria-label')).toContain('failed-today');
    await search('not-present');
    expect(container.querySelectorAll('.monitoring-run-row')).toHaveLength(0);
    expect(container.querySelector('.monitoring-trace-meta')).toBeNull();
    await click(button('清空筛选'));
    expect(container.querySelectorAll('.monitoring-run-row')).toHaveLength(3);
    expect(window.amd!.getDashboard).not.toHaveBeenCalled();
  });

  it('does not replace a manually selected historical run when a different live run arrives', async () => {
    const historical = run('historical', 'success', 1);
    vi.mocked(window.amd!.trace.list).mockResolvedValue([historical]);
    await render(createElement(RunHistoryPage, { liveTrace: trace(run('live-one', 'running')) }));
    await click([...container.querySelectorAll<HTMLButtonElement>('.monitoring-run-row')].find((item) => item.getAttribute('aria-label')?.includes('historical'))!);
    await render(createElement(RunHistoryPage, { liveTrace: trace(run('live-two', 'running')) }));
    expect(container.querySelector('.run-history-detail > header')!.textContent).toContain('historical');
    expect(window.amd!.trace.get).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale detail response after another run is selected', async () => {
    const first = deferred<RunTrace | undefined>();
    vi.mocked(window.amd!.trace.get).mockImplementation(async (id) => id === 'latest' ? first.promise : trace({ ...run(id), totalInputTokens: 999 }));
    await render(createElement(RunHistoryPage));
    await click(container.querySelectorAll<HTMLButtonElement>('.monitoring-run-row')[1]);
    expect(container.querySelector('.monitoring-trace-meta')!.textContent).toContain('1,004');
    await act(async () => { first.resolve(trace({ ...run('latest'), totalInputTokens: 111111 })); });
    expect(container.querySelector('.run-history-detail > header')!.textContent).toContain('previous');
    expect(container.querySelector('.monitoring-trace-meta')!.textContent).not.toContain('111,116');
  });

  it('explains missing traces and successfully retries the selected record', async () => {
    vi.mocked(window.amd!.trace.get).mockResolvedValueOnce(undefined);
    await render(createElement(RunHistoryPage));
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('可能已按保留策略清理');
    await click(button('重试'));
    expect(container.querySelector('.monitoring-trace-meta')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('retains a loaded list when a refresh fails without treating it as current data', async () => {
    await render(createElement(RunHistoryPage));
    vi.mocked(window.amd!.trace.list).mockRejectedValueOnce(new Error('storage unavailable'));
    await click(container.querySelector<HTMLButtonElement>('[aria-label="刷新运行记录"]')!);
    expect(container.querySelectorAll('.monitoring-run-row')).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('当前保留上次读取的记录');
  });

  it('offers explicit list and detail modes in compact windows', async () => {
    await render(createElement(RunHistoryPage));
    expect(container.querySelector('.run-history-page')!.classList.contains('is-list-collapsed')).toBe(true);
    await click(button('展开运行列表'));
    expect(container.querySelector('.run-history-page')!.classList.contains('is-list-open')).toBe(true);
    await click(container.querySelectorAll<HTMLButtonElement>('.monitoring-run-row')[1]);
    expect(container.querySelector('.run-history-page')!.classList.contains('is-list-collapsed')).toBe(true);
    expect(container.querySelector('.run-history-detail > header')!.textContent).toContain('previous');
  });

  it('distinguishes cancellation from execution failure in run messages', async () => {
    const cancelled = { ...run('cancelled', 'cancelled'), errorMessage: 'User cancelled' };
    await render(createElement(RunHistoryPage, { liveTrace: trace(cancelled) }));
    expect(container.querySelector('.monitoring-trace-error')!.textContent).toContain('本轮执行已取消');
    expect(container.querySelector('.monitoring-trace-error')!.textContent).not.toContain('本轮执行失败');
  });

  it('uses the latest detail status when the list still contains an earlier running snapshot', async () => {
    vi.mocked(window.amd!.trace.list).mockResolvedValue([run('transition', 'running')]);
    vi.mocked(window.amd!.trace.get).mockResolvedValue(trace({ ...run('transition', 'failed'), errorMessage: 'Connection failed' }));
    await render(createElement(RunHistoryPage));
    const header = container.querySelector('.run-history-detail > header')!;
    expect(header.querySelector('.run-status')!.textContent).toBe('失败');
    expect(header.querySelector('.run-status')!.classList.contains('failed')).toBe(true);
    expect(container.querySelector('.monitoring-trace-error')!.textContent).toContain('本轮执行失败');
  });
});
