// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitoringPage } from '../../src/renderer/pages/MonitoringPage';
import { RunHistoryPage } from '../../src/renderer/pages/RunHistoryPage';
import { Settings } from '../../src/renderer/pages/Settings';
import { RoutingPanel } from '../../src/renderer/components/RoutingPanel';
import { WorkspacePanel } from '../../src/renderer/components/WorkspacePanel';
import { FilePreview } from '../../src/renderer/components/FilePreview';
import { NewProjectDialog } from '../../src/renderer/components/NewProjectDialog';
import { Dashboard } from '../../src/renderer/components/Dashboard';
import { MemoryPanel } from '../../src/renderer/components/MemoryPanel';
import { TerminalPanel } from '../../src/renderer/components/TerminalPanel';
import * as highlighting from '../../src/renderer/highlightCode';
import type { AmdApi, DashboardSnapshot, MemoryRecord, ModelConfig, ProjectInfo, RunTrace, TraceRun } from '../../src/renderer/types';

let root: Root;
let container: HTMLDivElement;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const snapshot = (tasks = 1): DashboardSnapshot => ({
  range: { from: '2026-11-01T00:00:00Z', to: '2026-11-04T23:59:59Z' },
  summary: { totalTasks: tasks, totalInvocations: tasks, totalCost: 0, successRate: 1, avgLatency: 10 },
  modelUsage: [], costTrend: [], recent: [],
});
const run = (id: string): TraceRun => ({ id, sessionId: 's1', status: 'success', startedAt: '2026-11-04T01:00:00Z', totalInputTokens: 1, totalOutputTokens: 2, totalCost: 0 });
const trace = (id: string): RunTrace => ({ run: run(id), spans: [] });
const project: ProjectInfo = { id: 'p1', name: 'Sample', root: '/sample', displayRoot: '/sample', languages: [], markers: [] };
const model: ModelConfig = { id: 'm1', name: 'Loaded endpoint', modelId: 'loaded-model', provider: 'custom', enabled: true, baseURL: 'http://localhost/v1', maxTokens: 1000, contextWindow: 64000, capabilities: [], costPer1kTokens: { input: 0, output: 0 }, priority: 0 };
const render = async (element: React.ReactNode) => { await act(async () => { root.render(element); }); };
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)!;
const click = async (item: HTMLElement) => { await act(async () => { item.click(); }); };
const input = async (element: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollTo = vi.fn();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  window.amd = {
    getDashboard: vi.fn(async () => snapshot()),
    trace: { list: vi.fn(async () => []), get: vi.fn(async (id: string) => trace(id)), settings: vi.fn(async () => ({ maxAgeDays: 30, maxRuns: 1000 })) },
    listModels: vi.fn(async () => []),
    routingStatus: vi.fn(async () => ({ backend: 'heuristic', available: true })),
    routingRules: {
      get: vi.fn(async () => ({ path: '/routing-rules.json', text: JSON.stringify({ version: 1, defaults: { strategy: 'single' }, rules: [] }) })),
      set: vi.fn(async () => ({ diagnostics: [] })), history: vi.fn(async () => []),
    },
    project: { file: vi.fn(async () => ({ content: 'const value = 1;', truncated: false, size: 16 })), tree: vi.fn(async () => ({ name: 'sample', path: '', kind: 'directory', children: [] })) },
    projects: { pickDirectory: vi.fn(), create: vi.fn() },
  } as unknown as AmdApi;
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove(); delete window.amd; vi.restoreAllMocks();
});

describe('monitoring request ownership', () => {
  it('keeps the latest range response when an older request finishes last', async () => {
    const old = deferred<DashboardSnapshot>(), current = deferred<DashboardSnapshot>();
    vi.mocked(window.amd!.getDashboard).mockImplementation((options) => options?.range === '24h' ? current.promise : old.promise);
    await render(createElement(MonitoringPage));
    await click(button('24 小时'));
    await act(async () => { current.resolve(snapshot(24)); });
    await act(async () => { old.resolve(snapshot(7)); });
    expect(container.querySelector('.monitoring-metrics strong')!.textContent).toBe('24');
    expect(container.querySelector('.monitoring-page')!.getAttribute('aria-busy')).toBe('false');
  });

  it('hides the previous trace while another run is being loaded', async () => {
    vi.mocked(window.amd!.trace.list).mockResolvedValue([run('run-a'), run('run-b')]);
    const next = deferred<RunTrace>();
    vi.mocked(window.amd!.trace.get).mockImplementation(async (id) => id === 'run-b' ? next.promise : trace(id));
    await render(createElement(RunHistoryPage));
    expect(container.querySelector('.monitoring-trace header')!.textContent).toContain('run-a');
    await click(container.querySelectorAll<HTMLButtonElement>('.monitoring-run-row')[1]);
    expect(container.querySelector('.monitoring-trace header')!.textContent).toContain('run-b');
    expect(container.querySelector('.monitoring-trace-meta')).toBeNull();
    await act(async () => { next.resolve(trace('run-b')); });
    expect(container.querySelector('.monitoring-trace-meta')).not.toBeNull();
  });

  it('does not refetch a historical trace for unrelated streaming updates', async () => {
    vi.mocked(window.amd!.trace.list).mockResolvedValue([run('history')]);
    const live: RunTrace = { ...trace('live'), run: { ...run('live'), status: 'running' } };
    await render(createElement(RunHistoryPage, { liveTrace: live }));
    await click([...container.querySelectorAll<HTMLButtonElement>('.monitoring-run-row')].find((item) => item.textContent?.includes('history'))!);
    expect(window.amd!.trace.get).toHaveBeenCalledTimes(1);
    await render(createElement(RunHistoryPage, { liveTrace: { ...live, spans: [] } }));
    expect(window.amd!.trace.get).toHaveBeenCalledTimes(1);
    const loads = vi.mocked(window.amd!.trace.list).mock.calls.length;
    await render(createElement(RunHistoryPage, { liveTrace: { ...live, run: { ...live.run, status: 'success' } } }));
    expect(vi.mocked(window.amd!.trace.list).mock.calls.length).toBe(loads + 1);
  });

  it('applies the history time range to recent runs independently from dashboard aggregates', async () => {
    vi.mocked(window.amd!.trace.list).mockResolvedValue([{ ...run('recent'), startedAt: new Date().toISOString() }, { ...run('old'), startedAt: '2026-01-01T00:00:00Z' }]);
    await render(createElement(RunHistoryPage));
    await act(async () => {
      const range = container.querySelector<HTMLSelectElement>('[aria-label="运行记录时间范围"]')!;
      range.value = '24h'; range.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelectorAll('.monitoring-run-row')).toHaveLength(1);
    expect(container.querySelector('.monitoring-run-row')!.textContent).toContain('recent');
  });
});

describe('routing rule editing', () => {
  const loadRules = (ids: string[]) => {
    vi.mocked(window.amd!.routingRules.get).mockResolvedValue({ path: '/routing-rules.json', text: JSON.stringify({ version: 1, defaults: { strategy: 'single' }, rules: ids.map((id) => ({ id, when: {}, then: { strategy: 'single' } })) }) });
  };

  it('keeps the ID input mounted and focused while its value changes', async () => {
    loadRules(['rule-1']); await render(createElement(RoutingPanel, { onClose: vi.fn() }));
    const id = container.querySelector<HTMLInputElement>('[aria-label="规则 ID"]')!; id.focus();
    await input(id, 'renamed-rule');
    expect(container.querySelector('[aria-label="规则 ID"]')).toBe(id);
    expect(document.activeElement).toBe(id);
    await click(button('保存并生效'));
    expect(JSON.parse(vi.mocked(window.amd!.routingRules.set).mock.calls[0][0]).rules[0].id).toBe('renamed-rule');
  });

  it('generates unused rule IDs and clears saved state after structural changes', async () => {
    loadRules(['rule-1', 'rule-2']); await render(createElement(RoutingPanel, { onClose: vi.fn() }));
    await click(button('保存并生效')); expect(container.querySelector('.routing-saved')).not.toBeNull();
    await click(container.querySelector('[aria-label="删除规则"]')!);
    expect(container.querySelector('.routing-saved')).toBeNull();
    await click(button('添加规则'));
    expect([...container.querySelectorAll<HTMLInputElement>('[aria-label="规则 ID"]')].map((item) => item.value)).toEqual(['rule-2', 'rule-3']);
  });

  it('rejects duplicate IDs and disables editing until a save completes', async () => {
    loadRules(['first', 'second']); await render(createElement(RoutingPanel, { onClose: vi.fn() }));
    const ids = container.querySelectorAll<HTMLInputElement>('[aria-label="规则 ID"]');
    await input(ids[1], 'first'); await click(button('保存并生效'));
    expect(window.amd!.routingRules.set).not.toHaveBeenCalled(); expect(container.textContent).toContain('规则 ID 不能重复');
    await input(ids[1], 'second');
    const pending = deferred<{ policy: unknown; diagnostics: string[] }>(); vi.mocked(window.amd!.routingRules.set).mockReturnValue(pending.promise);
    await click(button('保存并生效'));
    expect(ids[0].matches(':disabled')).toBe(true); expect(button('JSON').disabled).toBe(true);
    await act(async () => { pending.resolve({ policy: {}, diagnostics: [] }); });
    expect(ids[0].matches(':disabled')).toBe(false);
  });

  it('prevents saving an unread policy and restores editing after a successful retry', async () => {
    vi.mocked(window.amd!.routingRules.get).mockRejectedValueOnce(new Error('规则文件暂时不可读'));
    await render(createElement(RoutingPanel, { onClose: vi.fn() }));
    expect(button('保存并生效').disabled).toBe(true);
    await click(button('保存并生效')); expect(window.amd!.routingRules.set).not.toHaveBeenCalled();
    expect(container.textContent).toContain('规则文件暂时不可读');
    loadRules(['preserved-rule']);
    await click(button('重新读取'));
    expect(button('保存并生效').disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>('[aria-label="规则 ID"]')!.value).toBe('preserved-rule');
    await click(button('保存并生效'));
    expect(JSON.parse(vi.mocked(window.amd!.routingRules.set).mock.calls[0][0]).rules[0].id).toBe('preserved-rule');
  });

  it('opens a loaded but invalid policy in the JSON editor so it can be repaired', async () => {
    vi.mocked(window.amd!.routingRules.get).mockResolvedValue({ path: '/routing-rules.json', text: '{invalid json' });
    await render(createElement(RoutingPanel, { onClose: vi.fn() }));
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="路由规则 JSON"]')!;
    expect(editor.value).toBe('{invalid json'); expect(editor.matches(':disabled')).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, JSON.stringify({ version: 1, defaults: { strategy: 'single' }, rules: [] }));
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('保存并生效')); expect(window.amd!.routingRules.set).toHaveBeenCalledOnce();
  });
});

describe('file preview consistency', () => {
  it('highlights multiline content once and reports truncated content', async () => {
    const highlight = vi.spyOn(highlighting, 'highlightCode');
    vi.mocked(window.amd!.project.file).mockResolvedValue({ content: '/* first line\nsecond line */\nconst x = 1;', truncated: true, size: 500000 });
    const props = { project, activePath: 'sample.ts', reloadKey: 0, onPreview: vi.fn(), onChangeDirectory: vi.fn() };
    await render(createElement(WorkspacePanel, props));
    expect(container.querySelector('.token.comment')!.textContent).toBe('/* first line\nsecond line */');
    expect(container.textContent).toContain('当前显示前面一部分内容');
    const calls = highlight.mock.calls.length;
    await render(createElement(WorkspacePanel, { ...props, onPreview: vi.fn() }));
    expect(highlight).toHaveBeenCalledTimes(calls);
  });

  it('does not reload a file when only the close callback changes', async () => {
    const firstClose = vi.fn(), lastClose = vi.fn();
    await render(createElement(FilePreview, { path: 'sample.ts', onClose: firstClose }));
    await render(createElement(FilePreview, { path: 'sample.ts', onClose: lastClose }));
    expect(window.amd!.project.file).toHaveBeenCalledOnce();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(firstClose).not.toHaveBeenCalled(); expect(lastClose).toHaveBeenCalledOnce();
  });
});

describe('settings and project dialogs', () => {
  it('saves media operations in the same model editor while disabling text-only actions', async () => {
    const mediaModel: ModelConfig = { ...model, operations: { 'image.generate': { protocol: 'openai-images', score: 85, estimatedCostUsd: 0.1 } } };
    const update = vi.fn(async (_id, payload) => ({ success: true, model: { ...mediaModel, ...payload } }));
    window.amd!.models = { list: vi.fn(async () => [mediaModel]), update, testConnection: vi.fn() } as unknown as AmdApi['models'];
    await render(createElement(Settings, { models: [mediaModel], onClose: vi.fn(), onModelsChanged: vi.fn(), onOpenRouting: vi.fn() }));
    expect(container.querySelector<HTMLInputElement>('[aria-label="图片生成"]')!.checked).toBe(true);
    expect(button('连通测试').disabled).toBe(true);
    expect(button('设为主力路由').disabled).toBe(true);
    await click(container.querySelector('[aria-label="支持 PNG"]')!);
    await click(container.querySelector('[aria-label="支持质量 高"]')!);
    await click(button('保存配置'));
    expect(update.mock.calls[0][1].operations).toEqual({ 'image.generate': { ...mediaModel.operations!['image.generate'], limits: { formats: ['png'], qualities: ['high'] } } });
    expect(window.amd!.models.testConnection).not.toHaveBeenCalled();
  });

  it('initializes a newly enabled image operation with the PNG protocol default', async () => {
    const update = vi.fn(async (_id, payload) => ({ success: true, model: { ...model, ...payload } }));
    window.amd!.models = { list: vi.fn(async () => [model]), update } as unknown as AmdApi['models'];
    await render(createElement(Settings, { models: [model], onClose: vi.fn(), onModelsChanged: vi.fn(), onOpenRouting: vi.fn() }));
    await click(container.querySelector('[aria-label="图片生成"]')!);
    await click(button('保存配置'));
    expect(update.mock.calls[0][1].operations['image.generate']).toMatchObject({ protocol: 'openai-images', defaults: { format: 'png' } });
  });
  it('selects models that arrive after settings opens without overwriting a started new draft', async () => {
    const props = { onClose: vi.fn(), onModelsChanged: vi.fn(), onOpenRouting: vi.fn() };
    await render(createElement(Settings, { ...props, models: [] }));
    await render(createElement(Settings, { ...props, models: [model] }));
    expect(container.querySelector<HTMLInputElement>('[placeholder="例如：DeepSeek 官方直连"]')!.value).toBe('Loaded endpoint');
    await click(button('添加模型'));
    const name = container.querySelector<HTMLInputElement>('[placeholder="例如：DeepSeek 官方直连"]')!;
    await input(name, 'My draft');
    await render(createElement(Settings, { ...props, models: [model, { ...model, id: 'm2' }] }));
    expect(name.value).toBe('My draft');
  });

  it('prevents repeated directory choices and closing during project creation', async () => {
    const picked = deferred<ProjectInfo & { existing: boolean }>(), created = deferred<ProjectInfo>();
    vi.mocked(window.amd!.projects.pickDirectory).mockReturnValue(picked.promise);
    vi.mocked(window.amd!.projects.create).mockReturnValue(created.promise);
    const onClose = vi.fn(), onCreated = vi.fn();
    await render(createElement(NewProjectDialog, { onClose, onCreated }));
    await click(button('选择本地文件夹…')); await click(button('选择本地文件夹…'));
    expect(window.amd!.projects.pickDirectory).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.disabled).toBe(true);
    await act(async () => { picked.resolve({ ...project, existing: false }); });
    await click(button('创建并打开项目'));
    expect(container.querySelector<HTMLInputElement>('#project-name')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.disabled).toBe(true);
    await act(async () => { created.resolve(project); });
    expect(onCreated).toHaveBeenCalledWith(project); expect(onClose).not.toHaveBeenCalled();
  });
});

describe('retained supporting panels', () => {
  it('keeps the latest dashboard range when an earlier request finishes late', async () => {
    const previous = deferred<DashboardSnapshot>(), current = deferred<DashboardSnapshot>();
    vi.mocked(window.amd!.getDashboard).mockImplementation((options) => options?.range === '24h' ? current.promise : previous.promise);
    await render(createElement(Dashboard, { onClose: vi.fn() }));
    await act(async () => {
      const range = container.querySelector('select')!; range.value = '24h'; range.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { current.resolve(snapshot(24)); });
    await act(async () => { previous.resolve(snapshot(7)); });
    expect(container.querySelector('.dashboard-kpis strong')!.textContent).toBe('24');
  });

  it('ignores memory lists loaded before a mutation and disables edits during saving', async () => {
    const older = deferred<MemoryRecord[]>(), added = deferred<MemoryRecord>();
    const record: MemoryRecord = { id: 'new', scope: 'global', kind: 'fact', content: 'Saved fact', tags: [], source: 'user', confidence: 1, status: 'active', createdAt: new Date(), updatedAt: new Date() };
    window.amd!.memory = { list: vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue([record]), settings: vi.fn(async () => ({ autoExtract: false })), add: vi.fn(() => added.promise) } as unknown as AmdApi['memory'];
    await render(createElement(MemoryPanel, { onClose: vi.fn(), hasProject: false }));
    const editor = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'Saved fact');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('保存记忆')); expect(editor.matches(':disabled')).toBe(true);
    await act(async () => { older.resolve([{ ...record, id: 'old', content: 'Obsolete fact' }]); });
    expect(container.textContent).not.toContain('Obsolete fact');
    await act(async () => { added.resolve(record); });
    expect(container.querySelector('.memory-item')!.textContent).toContain('Saved fact');
    expect(editor.matches(':disabled')).toBe(false);
  });

  it('does not launch another manual command when Enter is pressed while one is pending', async () => {
    const pending = deferred<Awaited<ReturnType<AmdApi['execution']['run']>>>();
    window.amd!.tty = { create: vi.fn(async () => ({ id: 'terminal-1' })), close: vi.fn(async () => ({ success: true })) } as unknown as AmdApi['tty'];
    window.amd!.on = vi.fn(() => () => undefined);
    window.amd!.project.current = vi.fn(async () => project);
    window.amd!.execution = { run: vi.fn(() => pending.promise) } as unknown as AmdApi['execution'];
    await render(createElement(TerminalPanel, { onClose: vi.fn() }));
    const editor = container.querySelector<HTMLInputElement>('[placeholder^="待审核命令"]')!;
    await input(editor, 'echo ready'); await click(button('审核并执行'));
    await act(async () => { editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(window.amd!.execution.run).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve({ id: 'cmd-1', command: 'echo ready', cwd: '/sample', stdout: 'ready', stderr: '', output: 'ready', exitCode: 0, timedOut: false, cancelled: false, truncated: false, durationMs: 1 }); });
  });
});
