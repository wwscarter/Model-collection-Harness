// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutingClassificationFeedback } from '../../src/renderer/components/RoutingClassificationFeedback';
import type { RoutingObservation, RoutingCorrection } from '../../src/core/growth/RoutingLearningStore';
import type { AmdApi, RunTrace } from '../../src/renderer/types';

const prediction = { taskType: 'code' as const, complexity: 'medium' as const, confidence: 0.8, backend: 'ollama' as const, model: 'local-router', promptVersion: 'v3', rationale: 'classification' };
const trace = (id: string): RunTrace => ({
  run: { id, sessionId: 'session-' + id, status: 'success', startedAt: new Date().toISOString(), totalInputTokens: 10, totalOutputTokens: 20, totalCost: 0 },
  spans: [{ id: 'route-' + id, runId: id, kind: 'route', name: 'route', status: 'success', startedAt: new Date().toISOString(), inputTokens: 0, outputTokens: 0, cost: 0, attributes: { classification: prediction } }],
});
const observation = (runId: string, description = '只审查已有函数，先不修改。'): RoutingObservation => ({ runId, sessionId: 'session-' + runId, description, classification: prediction });
const correction = (runId: string, taskType: 'review' | 'analysis' = 'review', complexity: 'high' | 'low' = 'high'): RoutingCorrection => ({
  id: 'correction-' + runId, runId, sessionId: 'session-' + runId, description: observation(runId).description,
  prediction, expected: { taskType, complexity }, source: 'user-correction', createdAt: new Date().toISOString(),
});
let root: Root;
let container: HTMLDivElement;
let get: ReturnType<typeof vi.fn>;
let correct: ReturnType<typeof vi.fn>;
let exportSamples: ReturnType<typeof vi.fn>;
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes(text));
const click = async (text: string) => { await act(async () => { button(text)!.click(); }); };
const render = async (run: RunTrace) => { await act(async () => { root.render(createElement(RoutingClassificationFeedback, { trace: run })); }); };
const select = async (label: string, value: string) => {
  await act(async () => {
    const control = container.querySelector<HTMLSelectElement>('[aria-label="' + label + '"]')!;
    control.value = value; control.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const submit = async () => { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  get = vi.fn(async (runId: string) => ({ observation: observation(runId) }));
  correct = vi.fn(async ({ runId }: { runId: string }) => correction(runId));
  exportSamples = vi.fn(async () => ({ version: 1, source: 'user-corrections', samples: [correction('run-a')] }));
  window.amd = { routingLearning: { get, correct, export: exportSamples } } as unknown as AmdApi;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove(); delete window.amd; vi.restoreAllMocks();
});

describe('explicit routing classification corrections', () => {
  it('only reads feedback after opening and never treats successful execution as a correct label', async () => {
    await render(trace('run-a'));
    expect(container.textContent).toContain('本机 Ollama');
    expect(container.textContent).toContain('local-router · v3');
    expect(get).not.toHaveBeenCalled(); expect(correct).not.toHaveBeenCalled();
    await click('纠正分类');
    expect(get).toHaveBeenCalledWith('run-a');
    expect(correct).not.toHaveBeenCalled();
    expect(container.textContent).toContain('不会训练模型权重，也不会发送到云端');
    expect(container.textContent).toContain('任务执行成功不代表分类正确');
    expect(container.textContent).toContain('只审查已有函数');
    expect(button('保存纠正样本（仅本机）')).toBeDefined();
  });

  it('ignores an older run response after the user switches traces', async () => {
    let finishOld!: (value: { observation: RoutingObservation }) => void;
    get.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    await render(trace('run-a')); await click('纠正分类');
    await render(trace('run-b')); await click('纠正分类');
    expect(get).toHaveBeenLastCalledWith('run-b');
    expect(container.textContent).toContain('只审查已有函数');
    await act(async () => { finishOld({ observation: observation('run-a', '旧会话的私有任务不应显示') }); });
    expect(container.textContent).not.toContain('旧会话的私有任务');
    await select('正确任务类型', 'review'); await select('正确复杂度', 'high'); await submit();
    expect(correct).toHaveBeenCalledWith({ runId: 'run-b', taskType: 'review', complexity: 'high' });
  });

  it('preserves selected labels on a failed save and updates only after explicit success', async () => {
    await render(trace('run-a')); await click('纠正分类');
    await select('正确任务类型', 'analysis'); await select('正确复杂度', 'low');
    correct.mockRejectedValueOnce(new Error('存储暂时不可用'));
    await submit();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('已保留选择');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="正确任务类型"]')!.value).toBe('analysis');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="正确复杂度"]')!.value).toBe('low');
    expect(container.textContent).not.toContain('已确认：');
    correct.mockResolvedValueOnce(correction('run-a', 'analysis', 'low'));
    await submit();
    expect(correct).toHaveBeenLastCalledWith({ runId: 'run-a', taskType: 'analysis', complexity: 'low' });
    expect(container.textContent).toContain('已确认：分析与比较 · 低复杂度');
    expect(container.textContent).toContain('纠正样本已保存到本机');
  });

  it('supports retrying an input read and does not invent input for an old run', async () => {
    get.mockRejectedValueOnce(new Error('读取失败')).mockResolvedValueOnce(undefined);
    await render(trace('run-a')); await click('纠正分类');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('读取失败');
    await click('重试读取');
    expect(container.textContent).toContain('当前轮未保留可纠正的输入');
    expect(container.textContent).toContain('不会从其他会话补取');
    expect(container.querySelector('form')).toBeNull();
    expect(correct).not.toHaveBeenCalled();
  });

  it('shows route metadata without a feedback bridge and makes no feedback requests', async () => {
    window.amd = {} as AmdApi;
    const current = trace('historical');
    current.spans[0].attributes = { classification: { ...prediction, backend: 'heuristic', fallbackReason: '本机服务超时' } };
    await render(current);
    expect(container.textContent).toContain('关键词规则');
    expect(container.textContent).toContain('本轮已回退规则：本机服务超时');
    expect(button('纠正分类')).toBeUndefined();
    expect(button('导出已确认样本')).toBeUndefined();
    expect(get).not.toHaveBeenCalled(); expect(correct).not.toHaveBeenCalled();
  });

  it('exports confirmed samples only when requested and releases the browser download URL', async () => {
    const createURL = vi.fn((_blob: Blob) => 'blob:confirmed-samples'); const revokeURL = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { value: createURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeURL, configurable: true });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      await render(trace('run-a'));
      expect(exportSamples).not.toHaveBeenCalled();
      await click('导出已确认样本');
      expect(exportSamples).toHaveBeenCalledOnce();
      expect(createURL.mock.calls[0][0]).toBeInstanceOf(Blob);
      expect(anchorClick).toHaveBeenCalledOnce();
      expect(revokeURL).toHaveBeenCalledWith('blob:confirmed-samples');
      expect(container.textContent).toContain('已导出 1 条已确认样本');
      expect(get).not.toHaveBeenCalled(); expect(correct).not.toHaveBeenCalled();
    } finally {
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate); else Reflect.deleteProperty(URL, 'createObjectURL');
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke); else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });
});
