// @vitest-environment jsdom
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/renderer/App';
import type { AmdApi } from '../../src/renderer/types';

let root: Root;
let container: HTMLDivElement;
let save: ReturnType<typeof vi.fn>;

const stored = {
  id: 'history-1', title: 'Conversation history', prompt: '历史草稿', projectId: undefined,
  projectRoot: undefined, createdAt: '2026-11-11T10:00:00.000Z', updatedAt: '2026-11-11T11:00:00.000Z',
  messages: [{ id: 'u', role: 'user', content: '历史问题' }, { id: 'a', role: 'assistant', content: '历史回答' }],
};

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }),
  });
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  save = vi.fn(async (session) => session);
  window.amd = {
    models: { list: vi.fn(async () => []) },
    sessions: {
      list: vi.fn(async () => [stored]), save,
      execute: vi.fn(() => new Promise(() => undefined)),
      delete: vi.fn(async () => ({ success: true })), cancel: vi.fn(async () => ({ success: true })),
    },
    projects: { list: vi.fn(async () => []) },
    project: { clear: vi.fn(async () => ({ success: true })), current: async () => undefined },
    on: () => () => undefined,
  } as unknown as AmdApi;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const FreshApp = App as ComponentType<{ startFresh?: boolean }>;
  await act(async () => { root.render(createElement(FreshApp, { startFresh: true })); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.amd;
});

describe('fresh launch session', () => {
  it('opens an unbound new conversation while history stays in the sidebar', () => {
    expect(container.querySelector('.topbar-title')?.textContent).toBe('新的工作会话');
    expect(container.querySelector('[aria-label="关联本地项目"]')).not.toBeNull();
    expect(container.querySelector('[aria-label^="当前项目"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
    expect([...container.querySelectorAll('.session-item')].some((item) => item.textContent?.includes('Conversation history'))).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('still restores a conversation when the user picks it', async () => {
    const history = [...container.querySelectorAll<HTMLButtonElement>('.session-item .item-main')].find((item) => item.textContent?.includes('Conversation history'))!;
    await act(async () => { history.click(); });
    expect(container.querySelector('.topbar-title')?.textContent).toBe('Conversation history');
    expect(container.querySelector('.workspace-content')?.textContent).toContain('历史回答');
  });
});
