// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/renderer/App';
import type { AmdApi } from '../../src/renderer/types';

let root: Root;
let container: HTMLDivElement;
let listeners: Map<string, (payload: unknown) => void>;
let rejectRun: (error: Error) => void;
let save: ReturnType<typeof vi.fn>;
let execute: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  listeners = new Map();
  save = vi.fn(async (session) => session);
  execute = vi.fn(() => new Promise((_resolve, reject) => { rejectRun = reject; }));
  cancel = vi.fn(async () => ({ success: true }));
  window.amd = {
    models: { list: async () => [] },
    sessions: {
      list: async () => [{ id: 's1', title: 'Project review', prompt: '继续检查', output: '', messages: [], createdAt: new Date().toISOString() }],
      save, execute, cancel,
    },
    projects: { list: async () => [] },
    project: { current: async () => undefined },
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener);
      return () => { listeners.delete(channel); };
    },
  } as unknown as AmdApi;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(App)); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  delete window.amd;
});

describe('workbench task controls', () => {
  it.each(['任务已取消', '模型连接已中断'])('saves final text without transient tool cards when a turn ends: %s', async (reason) => {
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="执行任务"]')!.click(); });
    expect(execute).toHaveBeenCalledOnce();
    const request = execute.mock.calls[0][0];
    await act(async () => {
      listeners.get('session:chunk')!({ sessionId: 's1', delta: '已读取项目说明。' });
      listeners.get('session:tool-call')!({ sessionId: 's1', assistantMessageId: request.assistantMessageId, toolCallId: 't1', toolName: 'read', status: 'running', args: { path: 'README.md' } });
    });
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="停止任务"]')!;
    expect(stop.disabled).toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
    await act(async () => {
      if (reason === '任务已取消') stop.click();
      rejectRun(new Error(reason));
    });
    if (reason === '任务已取消') expect(cancel).toHaveBeenCalledWith('s1');
    const saved = save.mock.calls.at(-1)![0];
    expect(saved.output).toBe('已读取项目说明。');
    expect(saved.messages.at(-1)).toMatchObject({ content: '已读取项目说明。' });
    expect(saved.messages.at(-1)).not.toHaveProperty('tools');
    expect(container.textContent).toContain(reason);
    expect(container.querySelector('[aria-label="停止任务"]')).toBeNull();
  });

  it('honors stop while the pending turn is still being saved', async () => {
    let finishSave!: () => void;
    save.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    cancel.mockResolvedValueOnce({ success: false });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="执行任务"]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="停止任务"]')!.click(); });
    await act(async () => { finishSave(); });
    expect(execute).not.toHaveBeenCalled();
    expect(container.textContent).toContain('任务已取消');
    expect(save).toHaveBeenCalledTimes(2);
  });
});
