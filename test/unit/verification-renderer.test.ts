// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/renderer/App';
import type { AmdApi } from '../../src/renderer/types';

let container: HTMLDivElement;
let root: Root;
let listeners: Map<string, (payload: unknown) => void>;
let execute: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn>;
let resolveRun: (result: unknown) => void;
let rejectRun: (error: Error) => void;
const click = async (selector: string) => { await act(async () => { container.querySelector<HTMLButtonElement>(selector)!.click(); }); };
const emit = async (channel: string, payload: unknown) => { await act(async () => { listeners.get(channel)!(payload); }); };
const setMode = async (mode: string) => {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="项目验证模式"]')!;
    select.value = mode; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const verification = () => container.querySelector('[aria-label="项目验证状态"]');

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  listeners = new Map();
  execute = vi.fn(() => new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; }));
  save = vi.fn(async (value) => value);
  window.amd = {
    models: { list: vi.fn(async () => []) },
    sessions: {
      list: vi.fn(async () => [{ id: 'current', title: '验证用会话', prompt: '修复普通项目错误', createdAt: new Date().toISOString(), messages: [{ id: 'old-user', role: 'user', content: '之前的问题' }, { id: 'old-answer', role: 'assistant', content: '之前的回答' }] }]),
      execute, save, delete: vi.fn(async () => ({ success: true })), cancel: vi.fn(async () => ({ success: true })),
    },
    projects: { list: vi.fn(async () => []) },
    project: { clear: vi.fn(async () => ({ success: true })) },
    on: (channel: string, listener: (payload: unknown) => void) => { listeners.set(channel, listener); return () => { listeners.delete(channel); }; },
  } as unknown as AmdApi;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(App)); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete window.amd; });

describe('project verification controls and progress', () => {
  it('defaults to quick checks and locks the choice while a run is active', async () => {
    expect(container.querySelector<HTMLSelectElement>('[aria-label="项目验证模式"]')!.value).toBe('quick');
    await click('[aria-label="执行任务"]');
    expect(execute.mock.calls[0][0].verificationMode).toBe('quick');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="项目验证模式"]')!.disabled).toBe(true);
    await act(async () => { resolveRun({ output: '普通完成结果' }); });
    expect(container.querySelector<HTMLSelectElement>('[aria-label="项目验证模式"]')!.disabled).toBe(false);
  });

  it.each(['off', 'full'])('sends the selected %s verification mode', async (mode) => {
    await setMode(mode);
    await click('[aria-label="执行任务"]');
    expect(execute.mock.calls[0][0].verificationMode).toBe(mode);
    await act(async () => { resolveRun({ output: '普通完成结果' }); });
  });

  it('shows checks and repair progress while replacing only the current answer stream', async () => {
    await click('[aria-label="执行任务"]');
    const assistantMessageId = execute.mock.calls[0][0].assistantMessageId;
    await emit('session:chunk', { sessionId: 'current', delta: '第一次尝试的回答' });
    await emit('session:verification', { sessionId: 'current', assistantMessageId, phase: 'checking', summary: '运行类型检查' });
    expect(verification()!.textContent).toContain('正在运行项目检查');
    expect(container.textContent).toContain('第一次尝试的回答');
    await emit('session:verification', { sessionId: 'current', assistantMessageId, phase: 'repair', summary: '修复类型错误' });
    expect(verification()!.textContent).toContain('正在修复');
    expect(container.textContent).not.toContain('第一次尝试的回答');
    expect(container.textContent).toContain('之前的回答');
    expect(container.textContent).not.toContain('正在路由并选择执行模型');
    await emit('session:chunk', { sessionId: 'current', delta: '修复后的回答' });
    expect(container.textContent).toContain('修复后的回答');
    await emit('session:verification', { sessionId: 'current', assistantMessageId, phase: 'completed', status: 'passed', summary: 'typecheck ✓' });
    expect(verification()!.textContent).toContain('验证通过');
    await emit('session:completed', { sessionId: 'current', output: '最终修复回答\n验证通过：typecheck ✓' });
    await act(async () => { resolveRun({ output: '最终修复回答\n验证通过：typecheck ✓' }); });
    expect(save.mock.calls.at(-1)![0].messages.at(-1).content).toBe('最终修复回答\n验证通过：typecheck ✓');
    expect(container.textContent).not.toContain('第一次尝试的回答');
  });

  it('ignores a late verification event for a previous assistant turn', async () => {
    await click('[aria-label="执行任务"]');
    await emit('session:chunk', { sessionId: 'current', delta: '当前轮的回答' });
    await emit('session:verification', { sessionId: 'current', assistantMessageId: 'old-answer', phase: 'repair' });
    expect(verification()).toBeNull();
    expect(container.textContent).toContain('当前轮的回答');
    expect(container.textContent).toContain('之前的回答');
    await act(async () => { resolveRun({ output: '当前轮的回答' }); });
  });

  it('settles the visible progress if the run fails during repair', async () => {
    await click('[aria-label="执行任务"]');
    const assistantMessageId = execute.mock.calls[0][0].assistantMessageId;
    await emit('session:verification', { sessionId: 'current', assistantMessageId, phase: 'repair' });
    await act(async () => { rejectRun(new Error('普通模型连接失败')); });
    expect(verification()!.textContent).toContain('验证未通过');
    expect(verification()!.textContent).toContain('普通模型连接失败');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="项目验证模式"]')!.disabled).toBe(false);
  });
});
