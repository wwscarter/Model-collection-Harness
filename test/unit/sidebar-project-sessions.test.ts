// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../../src/renderer/components/Sidebar';
import type { ProjectRecord } from '../../src/renderer/types';

let container: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof Sidebar>;
const project = (id: string): ProjectRecord => ({ id, name: `Project ${id}`, root: `/projects/${id}`, displayRoot: `/projects/${id}`, active: false, createdAt: new Date(), lastOpenedAt: new Date() });
const session = (id: string, projectId?: string) => ({ id, title: `Conversation ${id}`, projectId, createdAt: new Date() });
const render = async () => { await act(async () => { root.render(createElement(Sidebar, props)); }); };
const click = async (selector: string) => { await act(async () => { container.querySelector<HTMLButtonElement>(selector)!.click(); }); };
const branch = (id: string) => container.querySelector<HTMLElement>(`[data-project-id="${id}"]`)!;
const recent = () => container.querySelector<HTMLElement>('[aria-label="最近会话"]')!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  props = {
    projects: [project('p1'), project('p2')],
    sessions: [session('s1', 'p1'), session('s2', 'p1'), session('s3', 'p2'), session('standalone'), session('orphan', 'removed-project')],
    activeProjectId: 'p1', currentSessionId: 's1', runningSessionId: null,
    onNewSession: vi.fn(), onSelectSession: vi.fn(), onDeleteSession: vi.fn(), onNewProject: vi.fn(), onOpenProject: vi.fn(), onRemoveProject: vi.fn(),
  };
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('project conversation navigation', () => {
  it('nests bound conversations only beneath their project and keeps independent and orphaned history reachable', async () => {
    await render();
    expect([...branch('p1').querySelectorAll('.session-item .item-title-text')].map((item) => item.textContent)).toEqual(['Conversation s1', 'Conversation s2']);
    expect(branch('p2').querySelector('.project-sessions')).toBeNull();
    expect([...recent().querySelectorAll('.session-item .item-title-text')].map((item) => item.textContent)).toEqual(['Conversation standalone', 'Conversation orphan']);
    expect(branch('p1').querySelector('.session-item.active .item-main')?.getAttribute('aria-current')).toBe('true');
  });

  it('expands and navigates on the project name while its disclosure toggles without changing the selection', async () => {
    await render();
    await click('[data-project-id="p2"] .project-item .item-main');
    expect(props.onOpenProject).toHaveBeenCalledExactlyOnceWith('p2');
    expect(branch('p2').querySelector('.project-sessions')?.textContent).toContain('Conversation s3');
    await click('[data-project-id="p2"] .project-expand');
    expect(branch('p2').querySelector('.project-sessions')).toBeNull();
    expect(props.onOpenProject).toHaveBeenCalledOnce();
    await click('[data-project-id="p2"] .project-expand');
    await click('[data-project-id="p2"] .session-item .item-main');
    expect(props.onSelectSession).toHaveBeenCalledExactlyOnceWith('s3');
    expect(props.onOpenProject).toHaveBeenCalledOnce();
    expect(container.querySelector('button button')).toBeNull();
  });

  it('reveals a selected conversation when navigation changes externally', async () => {
    await render();
    await click('[aria-label="本地项目"] .group-toggle');
    expect(container.querySelector('.project-branch')).toBeNull();
    props = { ...props, activeProjectId: 'p2', currentSessionId: 's3' };
    await render();
    expect(branch('p2').querySelector('.session-item.active')?.textContent).toContain('Conversation s3');
    expect(branch('p2').querySelector('.project-expand')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('reveals orphaned history in the recent group when it is selected externally', async () => {
    await render();
    await click('[aria-label="最近会话"] .group-toggle');
    props = { ...props, activeProjectId: undefined, currentSessionId: 'orphan' };
    await render();
    expect(recent().querySelector('.session-item.active')?.textContent).toContain('Conversation orphan');
  });

  it('reveals search matches in collapsed projects and groups without duplicating them into recent history', async () => {
    await render();
    await click('[aria-label="本地项目"] .group-toggle');
    await click('[aria-label="最近会话"] .group-toggle');
    await click('[aria-label="搜索会话"]');
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索会话"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 's3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(branch('p2').querySelector('.project-sessions')?.textContent).toContain('Conversation s3');
    expect(container.querySelector('[data-project-id="p1"]')).toBeNull();
    expect(recent().querySelector('.session-item')).toBeNull();
    await click('[aria-label="关闭搜索"]');
    expect(container.querySelector('input[aria-label="搜索会话"]')).toBeNull();
    expect(container.querySelector('.project-branch')).toBeNull();
  });

  it('preserves run status and separate deletion actions in a project branch', async () => {
    props = { ...props, runningSessionId: 's3' };
    await render();
    expect(branch('p2').querySelector('.project-item .status-chip')?.textContent).toBe('进行中');
    await click('[data-project-id="p2"] .project-expand');
    expect(branch('p2').querySelector('.session-item .status-chip')?.textContent).toBe('进行中');
    await click('[data-project-id="p2"] .session-item .item-remove');
    expect(props.onDeleteSession).toHaveBeenCalledExactlyOnceWith('s3');
    await click('[data-project-id="p2"] .project-item .item-remove');
    expect(props.onRemoveProject).toHaveBeenCalledExactlyOnceWith('p2');
    expect(props.onOpenProject).not.toHaveBeenCalled();
    expect(props.onSelectSession).not.toHaveBeenCalled();
  });

  it('moves a conversation into its new project as soon as its association changes', async () => {
    await render();
    props = { ...props, sessions: props.sessions.map((item) => item.id === 's1' ? { ...item, projectId: 'p2' } : item), activeProjectId: 'p2' };
    await render();
    expect(branch('p1').querySelector('.project-sessions')?.textContent).not.toContain('Conversation s1');
    expect(branch('p2').querySelector('.session-item.active')?.textContent).toContain('Conversation s1');
    expect(recent().textContent).not.toContain('Conversation s1');
  });
});
