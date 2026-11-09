// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/renderer/App';
import type { AmdApi } from '../../src/renderer/types';

let root: Root;
let container: HTMLDivElement;
let save: ReturnType<typeof vi.fn>;
let execute: ReturnType<typeof vi.fn>;
let resolveRun: (value: unknown) => void;
const ruleText = () => container.querySelector<HTMLTextAreaElement>('[aria-label="本会话规则"]')!;
const setRules = async (value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ruleText(), value);
    ruleText().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const selectSession = async (id: string) => {
  await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('.session-item .item-main')].find((item) => item.textContent?.includes('Conversation ' + id))!.click(); });
};

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  save = vi.fn(async (session) => session);
  execute = vi.fn(() => new Promise((resolve) => { resolveRun = resolve; }));
  window.amd = {
    models: { list: vi.fn(async () => []) },
    sessions: {
      list: vi.fn(async () => ['a', 'b'].map((id) => ({ id, title: 'Conversation ' + id, prompt: '普通项目任务', createdAt: new Date().toISOString(), messages: [{ id: id + '-user', role: 'user', content: '之前的普通问题' }, { id: id + '-answer', role: 'assistant', content: '之前的普通回答' }] }))),
      save, execute, cancel: vi.fn(async () => ({ success: true })), delete: vi.fn(async () => ({ success: true })),
    },
    projects: { list: vi.fn(async () => []) },
    project: { clear: vi.fn(async () => ({ success: true })) },
    on: () => () => undefined,
  } as unknown as AmdApi;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(App)));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete window.amd; });

describe('temporary conversation rules', () => {
  it('only sends rules on this run request and leaves persisted messages and history unchanged', async () => {
    const rules = '普通临时约定：请使用简短中文说明。';
    await setRules(rules);
    expect(save).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="执行任务"]')!.click(); });
    const request = execute.mock.calls[0][0];
    expect(request.sessionRules).toBe(rules);
    expect(request.prompt).toBe('普通项目任务');
    expect(JSON.stringify(request.history)).not.toContain(rules);
    expect(ruleText().disabled).toBe(true);
    await act(async () => { resolveRun({ output: '普通完成结果' }); });
    expect(JSON.stringify(save.mock.calls)).not.toContain(rules);
    expect(save.mock.calls.every(([session]) => !Object.prototype.hasOwnProperty.call(session, 'sessionRules'))).toBe(true);
    expect(ruleText().disabled).toBe(false);
  });

  it('keeps different conversations isolated in memory and clears rules on remount', async () => {
    await setRules('Conversation A 的普通约定。');
    await selectSession('b');
    expect(ruleText().value).toBe('');
    await setRules('Conversation B 的普通约定。');
    await selectSession('a');
    expect(ruleText().value).toBe('Conversation A 的普通约定。');
    expect(save).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(App)));
    expect(ruleText().value).toBe('');
  });

  it('bounds the temporary text to 8000 characters before sending it', async () => {
    expect(ruleText().maxLength).toBe(8000);
    await setRules('普'.repeat(8_001));
    expect(ruleText().value).toHaveLength(8_000);
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="执行任务"]')!.click(); });
    expect(execute.mock.calls[0][0].sessionRules).toHaveLength(8_000);
    await act(async () => { resolveRun({ output: '普通完成结果' }); });
  });
});
