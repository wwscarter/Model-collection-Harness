// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceTimeline } from '../../src/renderer/components/TraceTimeline';
import { MonitoringPage } from '../../src/renderer/pages/MonitoringPage';
import type { AmdApi, RunTrace, TraceModelSnapshot } from '../../src/renderer/types';

const model: TraceModelSnapshot = {
  configurationId: 'custom-endpoint-older', modelId: 'actual-upstream-v2', name: 'Saved display name', provider: 'custom', endpointOrigin: 'https://gateway.example',
  costPer1kTokens: { input: 0.01, output: 0.02 }, configurationUpdatedAt: '2026-11-05T10:00:00Z',
};
const trace = (snapshot?: TraceModelSnapshot): RunTrace => ({
  run: { id: 'run-1', sessionId: 's1', status: 'success', startedAt: '2026-11-05T10:00:00Z', durationMs: 100, totalInputTokens: 10, totalOutputTokens: 5, totalCost: 0.01 },
  spans: [{ id: 'model-span', runId: 'run-1', kind: 'model', name: 'execution', modelId: 'custom-endpoint-older', status: 'success', startedAt: '2026-11-05T10:00:00Z', durationMs: 100, inputTokens: 10, outputTokens: 5, cost: 0.01, ...(snapshot ? { attributes: { modelSnapshot: snapshot } } : {}) }],
});
let container: HTMLDivElement;
let root: Root;
const render = async (element: React.ReactNode) => { await act(async () => { root.render(element); }); };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); delete window.amd; });

describe('historical model identity display', () => {
  it('labels hook spans and displays their recorded execution details', async () => {
    const value = trace();
    value.spans = [{ ...value.spans[0], kind: 'hook', modelId: undefined, name: 'ordinary-format', attributes: { phase: 'post_tool', command: 'npm run format', output: 'ordinary formatting completed' } }];
    await render(createElement(TraceTimeline, { trace: value, defaultOpen: true }));
    expect(container.querySelector('.trace-kind')!.textContent).toBe('钩子');
    await act(async () => { container.querySelector<HTMLButtonElement>('.trace-row')!.click(); });
    expect(container.querySelector('.trace-detail')!.textContent).toContain('post_tool');
    expect(container.querySelector('.trace-detail')!.textContent).toContain('npm run format');
  });
  it('shows the upstream snapshot in the row and keeps internal configuration identity separate in details', async () => {
    await render(createElement(TraceTimeline, { trace: trace(model), defaultOpen: true }));
    expect(container.querySelector('.trace-model')!.textContent).toBe('actual-upstream-v2');
    expect(container.querySelector('.trace-model')!.getAttribute('title')).toContain('配置ID: custom-endpoint-older');
    await act(async () => { container.querySelector<HTMLButtonElement>('.trace-row')!.click(); });
    const detail = container.querySelector('.trace-detail')!.textContent!;
    expect(detail).toContain('上游模型 IDactual-upstream-v2');
    expect(detail).toContain('配置 IDcustom-endpoint-older');
    expect(detail).toContain('配置名称Saved display name');
    expect(detail).toContain('预估费率 USD / 1K Token输入 0.01 / 输出 0.02');
  });

  it('labels legacy model IDs as configuration IDs instead of inventing the old upstream model', async () => {
    await render(createElement(TraceTimeline, { trace: trace(), defaultOpen: true }));
    expect(container.querySelector('.trace-model')!.textContent).toBe('配置ID: custom-endpoint-older');
    await act(async () => { container.querySelector<HTMLButtonElement>('.trace-row')!.click(); });
    expect(container.querySelector('.trace-detail')!.textContent).toContain('历史记录未保存实际模型型号');
    expect(container.querySelector('.trace-detail')!.textContent).not.toContain('上游模型 ID');
  });

  it('explains a migrated preset-rate flag without claiming the configured rate or bill is wrong', async () => {
    await render(createElement(TraceTimeline, { trace: trace({ ...model, pricingBasis: 'configured-token-rates', legacyPresetRates: true }), defaultOpen: true }));
    await act(async () => { container.querySelector<HTMLButtonElement>('.trace-row')!.click(); });
    expect(container.querySelector('.trace-detail')!.textContent).toContain('当前调用沿用旧预设费率，请按服务商价格核对');
    expect(container.querySelector('.trace-detail')!.textContent).toContain('显示费用为配置估算');
    expect(container.querySelector('.trace-detail')!.textContent).not.toContain('真实账单');
    expect(container.querySelector('.trace-model')!.textContent).toBe('actual-upstream-v2');
  });

  it('distinguishes aggregate configuration usage from actual models in the selected run', async () => {
    const current = trace(model);
    window.amd = {
      getDashboard: vi.fn(async () => ({ range: { from: '2026-11-01T00:00:00Z', to: '2026-11-06T00:00:00Z' }, summary: { totalTasks: 1, totalInvocations: 1, totalCost: 0.01, successRate: 1, avgLatency: 100 }, modelUsage: [{ modelId: 'custom-endpoint-older', invocations: 1, totalCost: 0.01, successRate: 1, share: 1 }], costTrend: [], recent: [] })),
      trace: { list: vi.fn(async () => [current.run]), get: vi.fn(async () => current) },
    } as unknown as AmdApi;
    await render(createElement(MonitoringPage, { liveTrace: current }));
    expect(container.querySelector('.monitoring-model-breakdown')!.textContent).toContain('模型配置分布');
    expect(container.querySelector('.monitoring-model-breakdown')!.textContent).toContain('配置ID: custom-endpoint-older');
    expect(container.querySelector('[aria-label="本轮实际模型"]')!.textContent).toContain('actual-upstream-v2');
    expect(container.querySelector('[aria-label="本轮实际模型"]')!.textContent).toContain('Saved display name · custom');
  });
});
