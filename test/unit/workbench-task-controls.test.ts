// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/renderer/App';
import type { AmdApi, ProjectInfo } from '../../src/renderer/types';

let root: Root;
let container: HTMLDivElement;
let listeners: Map<string, (payload: unknown) => void>;
let rejectRun: (error: Error) => void;
let resolveRun: (result: unknown) => void;
let save: ReturnType<typeof vi.fn>;
let execute: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
let listSessions: ReturnType<typeof vi.fn>;
let listModels: ReturnType<typeof vi.fn>;
let openProject: ReturnType<typeof vi.fn>;
let clearProject: ReturnType<typeof vi.fn>;
let listProjects: ReturnType<typeof vi.fn>;
let removeProject: ReturnType<typeof vi.fn>;

const sessionRecord = (id: string, projectId?: string) => ({ id, title: `Conversation ${id}`, prompt: '继续检查', output: '', messages: [], projectId, createdAt: new Date().toISOString() });
const projectInfo = (id: string): ProjectInfo => ({ id, name: `Project ${id}`, root: `/projects/${id}`, displayRoot: `/projects/${id}`, languages: [], markers: [] });
const click = async (selector: string) => {
  await act(async () => { container.querySelector<HTMLButtonElement>(selector)!.click(); });
};
const selectSession = async (id: string) => {
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>('.session-item .item-main')].find((button) => button.textContent?.includes(`Conversation ${id}`))!.click();
  });
};
const remount = async () => {
  await act(async () => { root.unmount(); });
  root = createRoot(container);
  await act(async () => { root.render(createElement(App)); });
};

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  listeners = new Map();
  save = vi.fn(async (session) => session);
  execute = vi.fn(() => new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; }));
  cancel = vi.fn(async () => ({ success: true }));
  remove = vi.fn(async () => ({ success: true }));
  listSessions = vi.fn(async () => [sessionRecord('s1')]);
  listModels = vi.fn(async () => []);
  openProject = vi.fn(async (id: string) => projectInfo(id));
  clearProject = vi.fn(async () => ({ success: true }));
  listProjects = vi.fn(async () => []);
  removeProject = vi.fn(async () => ({ success: true }));
  window.amd = {
    models: { list: listModels },
    sessions: {
      list: listSessions,
      save, execute, cancel, delete: remove,
    },
    projects: { list: listProjects, open: openProject, remove: removeProject },
    project: { current: async () => undefined, clear: clearProject },
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
  it('shows a completion event resource limit separately from the answer and preserves it when invoke resolves', async () => {
    await click('[aria-label="执行任务"]');
    const output = '已完成目录分析，后续还需要逐项检查。';
    await act(async () => {
      listeners.get('session:completed')!({ sessionId: 's1', output, stopReason: 'tool_limit', metrics: { inputTokens: 10, outputTokens: 5, cost: 0.03 } });
    });
    expect(container.querySelector('[aria-label="任务未完成"]')!.textContent).toContain('阶段性总结');
    expect(container.querySelector('.output-content')!.textContent).toContain(output);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { resolveRun({ output, metrics: { inputTokens: 10, outputTokens: 5, cost: 0.03 } }); });
    const saved = save.mock.calls.at(-1)![0];
    expect(saved.metrics).toMatchObject({ inputTokens: 10, outputTokens: 5, cost: 0.03, stopReason: 'tool_limit' });
    expect(saved.output).toBe(output);
    expect(saved.messages.at(-1).content).toBe(output);
    expect(container.querySelector('[aria-label="任务未完成"]')).not.toBeNull();
  });

  it.each(['top-level', 'metrics'])('restores a %s resource limit notice when the conversation is reopened', async (source) => {
    await click('[aria-label="执行任务"]');
    const output = '已取得阶段性结果。';
    const reason = source === 'top-level' ? { stopReason: 'tool_limit' } : { metrics: { stopReason: 'tool_limit' } };
    await act(async () => { resolveRun({ output, ...reason }); });
    const saved = save.mock.calls.at(-1)![0];
    expect(saved.metrics.stopReason).toBe('tool_limit');
    expect(container.querySelector('[aria-label="任务未完成"]')).not.toBeNull();
    listSessions.mockResolvedValue([saved]);
    await remount();
    expect(container.querySelector('[aria-label="任务未完成"]')!.textContent).toContain('任务尚未完成');
    expect(container.querySelector('.output-content')!.textContent).toContain(output);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not show an incomplete-task notice for an ordinary completed response', async () => {
    await click('[aria-label="执行任务"]');
    await act(async () => {
      listeners.get('session:completed')!({ sessionId: 's1', output: '任务完成', stopReason: 'stop' });
      resolveRun({ output: '任务完成', stopReason: 'stop' });
    });
    expect(container.querySelector('[aria-label="任务未完成"]')).toBeNull();
    expect(save.mock.calls.at(-1)![0].output).toBe('任务完成');
  });

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

  it('preserves the next prompt and model preference when the current answer completes', async () => {
    listModels.mockResolvedValue([{ id: 'next-model', name: 'Next model', modelId: 'next', enabled: true, provider: 'custom' }]);
    await remount();
    await click('[aria-label="执行任务"]');
    const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '下一轮草稿');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('[aria-label="切换模型"]');
    await act(async () => { container.querySelectorAll<HTMLButtonElement>('.model-menu-item')[1].click(); });
    expect(save.mock.calls.at(-1)![0]).toMatchObject({ prompt: '下一轮草稿', modelId: 'next-model', multiModel: false });
    await act(async () => { resolveRun({ output: '本轮结果', modelUsed: 'previous-model' }); });
    expect(input.value).toBe('下一轮草稿');
    expect(save.mock.calls.at(-1)![0]).toMatchObject({ prompt: '下一轮草稿', modelId: 'next-model', multiModel: false, output: '本轮结果' });
  });

  it('cancels a deleted running conversation and ignores its late result', async () => {
    await click('[aria-label="执行任务"]');
    await click('[aria-label="删除会话"]');
    expect(cancel).toHaveBeenCalledWith('s1');
    expect(remove).toHaveBeenCalledWith('s1');
    const savedBeforeResult = save.mock.calls.length;
    await act(async () => {
      listeners.get('session:completed')!({ sessionId: 's1', output: '迟到结果' });
      resolveRun({ output: '迟到结果' });
    });
    expect(save).toHaveBeenCalledTimes(savedBeforeResult);
    expect(container.textContent).not.toContain('迟到结果');
    expect(container.querySelector('.brand-notice-dot')).toBeNull();
  });

  it('waits for an initial save before deletion and never starts the deleted task', async () => {
    let finishSave!: () => void;
    save.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    await click('[aria-label="执行任务"]');
    await click('[aria-label="删除会话"]');
    expect(cancel).toHaveBeenCalledWith('s1');
    expect(remove).not.toHaveBeenCalled();
    await act(async () => { finishSave(); });
    expect(remove).toHaveBeenCalledWith('s1');
    expect(execute).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
  });

  it('makes deletion the last storage action when a completion save is already pending', async () => {
    await click('[aria-label="执行任务"]');
    let finishSave!: () => void;
    const actions: string[] = [];
    save.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = () => { actions.push('saved'); resolve(); }; }));
    remove.mockImplementation(async () => { actions.push('deleted'); return { success: true }; });
    await act(async () => { resolveRun({ output: '结果' }); });
    expect(save).toHaveBeenCalledTimes(2);
    await click('[aria-label="删除会话"]');
    expect(remove).not.toHaveBeenCalled();
    await act(async () => { finishSave(); });
    expect(actions).toEqual(['saved', 'deleted']);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('does not save a rejected run after its conversation was deleted', async () => {
    await click('[aria-label="执行任务"]');
    await click('[aria-label="删除会话"]');
    await act(async () => { rejectRun(new Error('任务已取消')); });
    expect(save).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('任务已取消');
  });

  it('shows background save failures even when the conversation has no assistant message', async () => {
    save.mockRejectedValueOnce(new Error('磁盘不可写'));
    await click('.new-session');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('会话保存失败：磁盘不可写');
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  it('keeps a newly created conversation selected when history finishes loading', async () => {
    let finishLoading!: (records: unknown[]) => void;
    listSessions.mockImplementationOnce(() => new Promise((resolve) => { finishLoading = resolve; }));
    await remount();
    await click('.new-session');
    const created = save.mock.calls.at(-1)![0];
    await act(async () => { finishLoading([sessionRecord('older')]); });
    expect(container.querySelector('.topbar-title')!.textContent).toBe('新的工作会话');
    expect(container.querySelector('.session-item.active')!.textContent).toContain('新的工作会话');
    expect(container.textContent).toContain('Conversation older');
    expect(created.id).not.toBe('older');
  });

  it('restores the conversation and explains a failed deletion', async () => {
    remove.mockRejectedValueOnce(new Error('数据库暂时忙'));
    await click('[aria-label="删除会话"]');
    expect(container.querySelector('.session-item.active')!.textContent).toContain('Conversation s1');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('会话删除失败：数据库暂时忙');
  });

  it('shows the same fallback model that is used when a pinned model is unavailable', async () => {
    listSessions.mockResolvedValue([{ ...sessionRecord('s1'), multiModel: false, modelId: 'removed' }]);
    listModels.mockResolvedValue([
      { id: 'first', name: 'First', modelId: 'first-model', provider: 'custom', enabled: true },
      { id: 'primary', name: 'Primary', modelId: 'primary-model', provider: 'custom', enabled: true, isPrimary: true },
    ]);
    await remount();
    expect(container.querySelector('[aria-label="切换模型"]')!.textContent).toContain('primary-model');
    await click('[aria-label="执行任务"]');
    expect(execute.mock.calls[0][0].pinnedModelId).toBe('primary');
  });
});

describe('conversation project selection', () => {
  it('clears the main selection when opening an unassociated conversation and sends explicit null', async () => {
    listSessions.mockResolvedValue([sessionRecord('s1', 'p1'), sessionRecord('s2')]);
    await remount();
    expect(container.querySelector('[aria-label="当前项目：Project p1"]')).not.toBeNull();
    const clearsBeforeSwitch = clearProject.mock.calls.length;
    await selectSession('s2');
    expect(clearProject.mock.calls.length).toBeGreaterThan(clearsBeforeSwitch);
    expect(container.querySelector('[aria-label="关联本地项目"]')).not.toBeNull();
    await click('[aria-label="执行任务"]');
    expect(execute.mock.calls[0][0]).toMatchObject({ sessionId: 's2', projectId: null });
  });

  it('keeps the submitted project when the current conversation changes during its initial save', async () => {
    listSessions.mockResolvedValue([sessionRecord('s1', 'p1'), sessionRecord('s2', 'p2')]);
    await remount();
    let finishSave!: () => void;
    save.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    await click('[aria-label="执行任务"]');
    await selectSession('s2');
    await act(async () => { finishSave(); });
    expect(execute.mock.calls[0][0]).toMatchObject({ sessionId: 's1', projectId: 'p1' });
    expect(container.querySelector('[aria-label="当前项目：Project p2"]')).not.toBeNull();
  });

  it('ignores a slow open response after switching to an unassociated conversation', async () => {
    listSessions.mockResolvedValue([sessionRecord('s1'), sessionRecord('s2', 'p2')]);
    await remount();
    let finishOpen!: (project: ProjectInfo) => void;
    let mainProject: ProjectInfo | undefined;
    openProject.mockImplementationOnce(() => new Promise<ProjectInfo>((resolve) => { finishOpen = (project) => { mainProject = project; resolve(project); }; }));
    clearProject.mockImplementation(async () => { mainProject = undefined; return { success: true }; });
    await selectSession('s2');
    await selectSession('s1');
    await act(async () => { finishOpen(projectInfo('p2')); });
    expect(mainProject).toBeUndefined();
    expect(container.querySelector('[aria-label="关联本地项目"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="当前项目：Project p2"]')).toBeNull();
  });

  it('clears the old project and file preview when a conversation project cannot be reopened', async () => {
    listSessions.mockResolvedValue([sessionRecord('s1', 'p1'), sessionRecord('s2', 'missing')]);
    await remount();
    openProject.mockRejectedValueOnce(new Error('项目记录不存在'));
    const clearsBeforeSwitch = clearProject.mock.calls.length;
    await selectSession('s2');
    expect(clearProject.mock.calls.length).toBeGreaterThanOrEqual(clearsBeforeSwitch + 2);
    expect(container.querySelector('[aria-label="关联本地项目"]')).not.toBeNull();
    expect(container.textContent).toContain('项目记录不存在');
    expect(container.querySelector('[aria-label="当前项目：Project p1"]')).toBeNull();
  });

  it('preserves a project association changed while a run is in progress', async () => {
    listSessions.mockResolvedValue([sessionRecord('s1', 'p1')]);
    listProjects.mockResolvedValue([projectInfo('p1'), projectInfo('p2')]);
    await remount();
    await click('[aria-label="执行任务"]');
    await click('.composer-project-main');
    await act(async () => { container.querySelectorAll<HTMLButtonElement>('.project-menu-item')[1].click(); });
    await act(async () => { resolveRun({ output: '结果' }); });
    expect(save.mock.calls.at(-1)![0]).toMatchObject({ projectId: 'p2', projectRoot: '/projects/p2', output: '结果' });
    expect(container.querySelector('[aria-label="当前项目：Project p2"]')).not.toBeNull();
  });

  it('unbinds conversations when their project is removed from the list', async () => {
    listSessions.mockResolvedValue([sessionRecord('s1', 'p1'), sessionRecord('s2', 'p1')]);
    listProjects.mockResolvedValue([projectInfo('p1')]);
    await remount();
    await click('[aria-label="从列表移除 Project p1"]');
    expect(removeProject).toHaveBeenCalledWith('p1');
    expect(save.mock.calls.map(([session]) => ({ id: session.id, projectId: session.projectId }))).toEqual([{ id: 's1', projectId: undefined }, { id: 's2', projectId: undefined }]);
    expect(container.querySelector('[aria-label="关联本地项目"]')).not.toBeNull();
    const opensBeforeSwitch = openProject.mock.calls.length;
    await selectSession('s2');
    expect(openProject).toHaveBeenCalledTimes(opensBeforeSwitch);
    await click('[aria-label="执行任务"]');
    expect(execute.mock.calls[0][0]).toMatchObject({ sessionId: 's2', projectId: null });
  });
});
