// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/renderer/App';
import type { AmdApi, ProjectInfo } from '../../src/renderer/types';

let root: Root;
let container: HTMLDivElement;
let listeners: Map<string, (payload: unknown) => void>;
let listSessions: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn>;
let execute: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
let openProject: ReturnType<typeof vi.fn>;
let clearProject: ReturnType<typeof vi.fn>;
let resolveRun: (result: unknown) => void;

const project = (id: string): ProjectInfo => ({ id, name: 'Project ' + id, root: '/projects/' + id, displayRoot: '/projects/' + id, languages: [], markers: [] });
const conversation = (id: string, projectId: string, updatedAt = '2026-11-05T01:00:00Z') => ({
  id, projectId, projectRoot: '/projects/' + projectId, title: 'Conversation ' + id,
  prompt: 'Draft ' + id, output: 'Answer ' + id,
  messages: [{ id: id + '-user', role: 'user', content: 'Question ' + id }, { id: id + '-answer', role: 'assistant', content: 'Answer ' + id }],
  createdAt: '2026-11-04T01:00:00Z', updatedAt,
});
const click = async (element: HTMLElement | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => { element!.click(); });
};
const enterProject = async (id: string) => click([...container.querySelectorAll<HTMLButtonElement>('.project-item .item-main')].find((item) => item.textContent?.trim() === 'Project ' + id));
const selectConversation = async (id: string) => click([...container.querySelectorAll<HTMLButtonElement>('.session-item .item-main')].find((item) => item.textContent?.includes('Conversation ' + id)));
const output = () => container.querySelector('.workspace-content')!.textContent!;
const draft = () => container.querySelector<HTMLTextAreaElement>('textarea')!;
const setDraft = async (value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft(), value);
    draft().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const mount = async (records: ReturnType<typeof conversation>[]) => {
  listSessions.mockResolvedValue(records);
  await act(async () => { root.render(createElement(App)); });
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  listeners = new Map();
  listSessions = vi.fn(async () => []);
  save = vi.fn(async (session) => session);
  execute = vi.fn(() => new Promise((resolve) => { resolveRun = resolve; }));
  remove = vi.fn(async () => ({ success: true }));
  openProject = vi.fn(async (id: string) => project(id));
  clearProject = vi.fn(async () => ({ success: true }));
  window.amd = {
    models: { list: vi.fn(async () => []) },
    sessions: { list: listSessions, save, execute, delete: remove, cancel: vi.fn(async () => ({ success: true })) },
    projects: { list: vi.fn(async () => ['p1', 'p2', 'p3'].map(project)), open: openProject, remove: vi.fn(async () => ({ success: true })) },
    project: { current: async () => undefined, clear: clearProject, tree: async () => ({ name: 'project', path: '.', kind: 'directory', children: [] }) },
    on: (channel: string, listener: (payload: unknown) => void) => { listeners.set(channel, listener); return () => { listeners.delete(channel); }; },
  } as unknown as AmdApi;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  delete window.amd;
  vi.restoreAllMocks();
});

describe('project conversation navigation', () => {
  it('opens the project conversation and changes the answer without moving the previous conversation', async () => {
    await mount([conversation('a', 'p1'), conversation('b', 'p2')]);
    await enterProject('p2');
    expect(container.querySelector('.session-item.active')!.textContent).toContain('Conversation b');
    expect(container.querySelector('[aria-label="当前项目：Project p2"]')).not.toBeNull();
    expect(output()).toContain('Answer b');
    expect(output()).not.toContain('Answer a');
    expect(save.mock.calls.some(([session]) => session.id === 'a' && session.projectId === 'p2')).toBe(false);
    await enterProject('p1');
    expect(output()).toContain('Answer a');
    expect(container.querySelector('[aria-label="当前项目：Project p1"]')).not.toBeNull();
  });

  it('uses the newest project conversation initially and then restores its last viewed conversation', async () => {
    await mount([conversation('initial', 'p3'), conversation('older', 'p1', '2026-11-04T01:00:00Z'), conversation('newer', 'p1', '2026-11-05T01:00:00Z'), conversation('other', 'p2')]);
    await enterProject('p1');
    expect(output()).toContain('Answer newer');
    await selectConversation('older');
    expect(output()).toContain('Answer older');
    await enterProject('p2');
    await enterProject('p1');
    expect(output()).toContain('Answer older');
    expect(container.querySelector('.session-item.active')!.textContent).toContain('Conversation older');
  });

  it('keeps each project conversation draft while moving between projects', async () => {
    await mount([conversation('a', 'p1'), conversation('b', 'p2')]);
    await setDraft('项目一尚未发送的任务');
    await enterProject('p2');
    expect(draft().value).toBe('Draft b');
    await setDraft('项目二尚未发送的任务');
    await enterProject('p1');
    expect(draft().value).toBe('项目一尚未发送的任务');
    expect(output()).toContain('Answer a');
    await enterProject('p2');
    expect(draft().value).toBe('项目二尚未发送的任务');
  });

  it('creates one empty project conversation and reuses it on subsequent visits', async () => {
    await mount([conversation('a', 'p1')]);
    await enterProject('p3');
    expect(container.querySelector('[aria-label="当前项目：Project p3"]')).not.toBeNull();
    expect(container.querySelector('.output-content')).toBeNull();
    expect(draft().value).toBe('');
    expect(output()).toContain('当前项目 · Project p3');
    await click(container.querySelector<HTMLButtonElement>('[aria-label="收起工作区文件"]'));
    expect(container.querySelector('.workspace-panel')).toBeNull();
    await click(container.querySelector<HTMLButtonElement>('.welcome-project-link'));
    expect(container.querySelector('.workspace-panel')).not.toBeNull();
    expect(container.querySelector('.new-project-window')).toBeNull();
    const created = save.mock.calls.find(([session]) => session.projectId === 'p3')![0];
    expect(created).toMatchObject({ projectId: 'p3', projectRoot: '/projects/p3', messages: [], output: '', prompt: '' });
    await setDraft('空项目里的草稿');
    await enterProject('p1');
    await enterProject('p3');
    expect(draft().value).toBe('空项目里的草稿');
    expect(new Set(save.mock.calls.filter(([session]) => session.projectId === 'p3').map(([session]) => session.id))).toEqual(new Set([created.id]));
  });

  it('keeps stream updates and completion with their originating project after navigation', async () => {
    await mount([conversation('a', 'p1'), conversation('b', 'p2')]);
    await click(container.querySelector<HTMLButtonElement>('[aria-label="执行任务"]'));
    expect(execute.mock.calls[0][0]).toMatchObject({ sessionId: 'a', projectId: 'p1' });
    await enterProject('p2');
    await act(async () => { listeners.get('session:chunk')!({ sessionId: 'a', delta: '项目一后台输出' }); });
    expect(output()).toContain('Answer b');
    expect(output()).not.toContain('项目一后台输出');
    expect(container.querySelector('[aria-label="停止任务"]')).toBeNull();
    await act(async () => {
      listeners.get('session:completed')!({ sessionId: 'a', output: '项目一后台完成' });
      resolveRun({ output: '项目一后台完成' });
    });
    expect(output()).toContain('Answer b');
    expect(output()).not.toContain('项目一后台完成');
    expect([...save.mock.calls].reverse().find(([session]) => session.id === 'a')![0]).toMatchObject({ projectId: 'p1', output: '项目一后台完成' });
    await enterProject('p1');
    expect(output()).toContain('项目一后台完成');
  });

  it('ignores a delayed project open when a newer project is already selected', async () => {
    await mount([conversation('a', 'p1'), conversation('b', 'p2'), conversation('c', 'p3')]);
    let finishOpen!: (value: ProjectInfo) => void;
    let mainProject: ProjectInfo | undefined = project('p1');
    clearProject.mockImplementation(async () => { mainProject = undefined; return { success: true }; });
    openProject.mockImplementation(async (id: string) => { mainProject = project(id); return mainProject; });
    openProject.mockImplementationOnce(() => new Promise<ProjectInfo>((resolve) => { finishOpen = (value) => { mainProject = value; resolve(value); }; }));
    await enterProject('p2');
    expect(output()).toContain('Answer b');
    await enterProject('p3');
    expect(output()).toContain('Answer c');
    await act(async () => { finishOpen(project('p2')); });
    expect(mainProject?.id).toBe('p3');
    expect(container.querySelector('[aria-label="当前项目：Project p3"]')).not.toBeNull();
    expect(output()).toContain('Answer c');
    expect(output()).not.toContain('Answer b');
  });

  it('creates new conversations in the selected project and restores the new draft on return', async () => {
    await mount([conversation('a', 'p1'), conversation('b', 'p2')]);
    await enterProject('p2');
    await click(container.querySelector<HTMLButtonElement>('.new-session'));
    const created = [...save.mock.calls].reverse().find(([session]) => session.projectId === 'p2')![0];
    expect(created.id).not.toBe('b');
    expect(created).toMatchObject({ projectId: 'p2', messages: [], output: '', prompt: '' });
    expect(container.querySelector('.output-content')).toBeNull();
    await setDraft('新的项目二会话');
    await enterProject('p1');
    await enterProject('p2');
    expect(draft().value).toBe('新的项目二会话');
    expect(container.querySelector('.output-content')).toBeNull();
  });

  it('selects another conversation from the same project when its current conversation is deleted', async () => {
    await mount([conversation('a', 'p1'), conversation('other-project', 'p2', '2026-11-05T05:00:00Z'), conversation('same-project', 'p1', '2026-11-04T05:00:00Z')]);
    await click(container.querySelector<HTMLButtonElement>('.session-item.active .item-remove'));
    expect(remove).toHaveBeenCalledWith('a');
    expect(container.querySelector('.session-item.active')!.textContent).toContain('Conversation same-project');
    expect(output()).toContain('Answer same-project');
    expect(container.querySelector('[aria-label="当前项目：Project p1"]')).not.toBeNull();
  });

  it('restores the deleted project conversation and its error when deletion fails in place', async () => {
    await mount([conversation('a', 'p1'), conversation('b', 'p2')]);
    remove.mockRejectedValueOnce(new Error('数据库暂时忙'));
    await click(container.querySelector<HTMLButtonElement>('.session-item.active .item-remove'));
    expect(container.querySelector('.session-item.active')!.textContent).toContain('Conversation a');
    expect(output()).toContain('Answer a');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('会话删除失败：数据库暂时忙');
    expect(container.querySelector('[aria-label="当前项目：Project p1"]')).not.toBeNull();
  });

  it('does not steal focus from a newly selected project when an earlier deletion fails', async () => {
    await mount([conversation('a', 'p1'), conversation('b', 'p2')]);
    let failDelete!: (cause: Error) => void;
    remove.mockImplementationOnce(() => new Promise((_resolve, reject) => { failDelete = reject; }));
    await click(container.querySelector<HTMLButtonElement>('.session-item.active .item-remove'));
    await enterProject('p2');
    await act(async () => { failDelete(new Error('数据库暂时忙')); });
    expect(container.querySelector('.session-item.active')!.textContent).toContain('Conversation b');
    expect(output()).toContain('Answer b');
    expect(container.querySelector('[aria-label="当前项目：Project p2"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('uses a newly associated project immediately while its workspace is still opening', async () => {
    await mount([conversation('a', 'p1'), conversation('b', 'p2')]);
    let finishOpen!: (value: ProjectInfo) => void;
    openProject.mockImplementationOnce(() => new Promise<ProjectInfo>((resolve) => { finishOpen = resolve; }));
    await click(container.querySelector<HTMLButtonElement>('.composer-project-main'));
    await click([...container.querySelectorAll<HTMLButtonElement>('.project-menu-item')].find((item) => item.textContent?.includes('Project p2')));
    await click(container.querySelector<HTMLButtonElement>('[aria-label="执行任务"]'));
    expect(execute.mock.calls[0][0]).toMatchObject({ sessionId: 'a', projectId: 'p2' });
    expect(save.mock.calls.some(([session]) => session.id === 'a' && session.projectId === 'p2')).toBe(true);
    await act(async () => { finishOpen(project('p2')); resolveRun({ output: '已在项目二执行' }); });
    expect(output()).toContain('已在项目二执行');
  });

  it('retains an explicit association when navigation supersedes its pending workspace open', async () => {
    await mount([conversation('a', 'p1'), conversation('c', 'p3')]);
    let finishOpen!: (value: ProjectInfo) => void;
    openProject.mockImplementationOnce(() => new Promise<ProjectInfo>((resolve) => { finishOpen = resolve; }));
    await click(container.querySelector<HTMLButtonElement>('.composer-project-main'));
    await click([...container.querySelectorAll<HTMLButtonElement>('.project-menu-item')].find((item) => item.textContent?.includes('Project p2')));
    await enterProject('p3');
    await act(async () => { finishOpen(project('p2')); });
    expect([...save.mock.calls].reverse().find(([session]) => session.id === 'a')![0]).toMatchObject({ projectId: 'p2', projectRoot: '/projects/p2' });
    expect(output()).toContain('Answer c');
    expect(container.querySelector('[aria-label="当前项目：Project p3"]')).not.toBeNull();
    await enterProject('p2');
    expect(container.querySelector('.session-item.active')!.textContent).toContain('Conversation a');
    expect(output()).toContain('Answer a');
  });

  it('stays in the project with an empty conversation after deleting its final conversation', async () => {
    await mount([conversation('a', 'p1'), conversation('other-project', 'p2')]);
    await click(container.querySelector<HTMLButtonElement>('.session-item.active .item-remove'));
    expect(remove).toHaveBeenCalledWith('a');
    expect(container.querySelector('[aria-label="当前项目：Project p1"]')).not.toBeNull();
    expect(output()).not.toContain('Answer other-project');
    expect(container.querySelector('.output-content')).toBeNull();
    expect(draft().value).toBe('');
  });
});
