// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanCard } from '../../src/renderer/components/PlanCard';
import type { RunPlan } from '../../src/core/planning/PlanTypes';

let container: HTMLDivElement; let root: Root;
const record = (executionMode: RunPlan['executionMode'] = 'confirm'): RunPlan => ({ sessionId: 'session', runId: 'run', assistantMessageId: 'message', version: 1, executionMode, status: executionMode === 'confirm' ? 'awaiting' : 'completed', createdAt: '', updatedAt: '', plan: { mode: 'direct', taskType: 'code', complexity: 'low', steps: [{ id: 'inspect', title: '检查文件', detail: '阅读相关实现。', status: 'pending' }], subagents: [], verify: true } });
const click = async (label: string) => { await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!.click()); };
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('execution plan card', () => {
  it.each(['auto', 'only'] as const)('renders the %s plan as a read-only record', async (mode) => {
    const onDecision = vi.fn();
    await act(async () => root.render(createElement(PlanCard, { record: record(mode), active: true, onDecision })));
    expect(container.textContent).toContain('检查文件'); expect(container.textContent).toContain('包含复核');
    expect(container.querySelector('button')).toBeNull();
    if (mode === 'only') expect(container.textContent).toContain('未执行工具或项目修改');
  });
  it('edits step content before saving a new version and approves the displayed version', async () => {
    const onDecision = vi.fn(async () => undefined);
    await act(async () => root.render(createElement(PlanCard, { record: record(), active: true, onDecision })));
    await click('修改计划');
    const input = container.querySelector<HTMLInputElement>('[aria-label="计划步骤 1"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '检查并验证文件'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await click('保存修改');
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ action: 'edit', version: 1, steps: [expect.objectContaining({ id: 'inspect', title: '检查并验证文件' })] }));
    await click('执行计划'); expect(onDecision).toHaveBeenLastCalledWith({ runId: 'run', version: 1, action: 'approve' });
  });
  it('exposes cancel and retains the plan with a normal save error', async () => {
    const onDecision = vi.fn(async () => { throw new Error('计划保存失败'); });
    await act(async () => root.render(createElement(PlanCard, { record: record(), active: true, onDecision })));
    await click('取消任务'); expect(onDecision).toHaveBeenCalledWith({ runId: 'run', version: 1, action: 'cancel' });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('计划保存失败');
    expect(container.textContent).toContain('检查文件');
  });
});
