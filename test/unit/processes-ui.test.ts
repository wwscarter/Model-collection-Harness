// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessesDrawer } from '../../src/renderer/components/ProcessesDrawer';
import { ProcessCleanupModal } from '../../src/renderer/components/ProcessCleanupModal';
import type { AmdApi, ProcessSummary } from '../../src/renderer/types';

let root: Root;
let container: HTMLDivElement;
let list: ReturnType<typeof vi.fn<(projectRoot?: string, sessionId?: string) => Promise<ProcessSummary[]>>>;
let stop: ReturnType<typeof vi.fn<(processId: string, projectRoot?: string) => Promise<ProcessSummary>>>;

const process = (overrides: Partial<ProcessSummary> = {}): ProcessSummary => ({
  processId: 'process-1', pid: 123, sessionId: 'session-1', command: 'npm run dev', cwd: '/project',
  status: 'running', running: true, urls: ['http://127.0.0.1:5173/'], exitCode: null, timedOut: false,
  cancelled: false, durationMs: 4_200, sandboxEnabled: true, outputPreview: 'ready in 300ms', ...overrides,
});

const normalize = (value: string | null | undefined) => value?.replace(/\s+/g, '') ?? '';
const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => normalize(item.textContent) === text)!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }),
  });
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  list = vi.fn(async () => [process(), process({ processId: 'process-2', sessionId: 'other', command: 'node server.cjs', running: false, status: 'stopped', urls: [], durationMs: 1_500 })]);
  stop = vi.fn(async () => process({ running: false, status: 'stopped' }));
  window.amd = { processes: { list, stop } } as unknown as AmdApi;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.amd;
});

async function render(element: React.ReactElement) {
  await act(async () => { root.render(element); await new Promise((resolve) => setTimeout(resolve, 30)); });
}

describe('ProcessesDrawer', () => {
  it('lists managed processes and stops one after confirmation', async () => {
    await render(createElement(ProcessesDrawer, { open: true, onClose: vi.fn(), projectRoot: '/project', sessionId: 'session-1' }));
    expect(list).toHaveBeenCalledWith('/project');
    expect(document.body.textContent).toContain('npm run dev');
    expect(document.body.textContent).toContain('node server.cjs');
    expect(document.body.textContent).toContain('本会话');
    expect(document.body.textContent).toContain('http://127.0.0.1:5173/');
    expect(document.body.textContent).toContain('ready in 300ms');

    await act(async () => { button('停止').click(); await new Promise((resolve) => setTimeout(resolve, 50)); });
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter((item) => normalize(item.textContent) === '停止').at(-1)!;
    await act(async () => { confirm.click(); await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(stop).toHaveBeenCalledWith('process-1', '/project');
  });

  it('shows an empty state when the project has no managed processes', async () => {
    list.mockResolvedValueOnce([]);
    await render(createElement(ProcessesDrawer, { open: true, onClose: vi.fn() }));
    expect(document.body.textContent).toContain('当前没有由智能体启动的后台进程');
  });

  it('does not poll while closed', async () => {
    await render(createElement(ProcessesDrawer, { open: false, onClose: vi.fn() }));
    expect(list).not.toHaveBeenCalled();
  });
});

describe('ProcessCleanupModal', () => {
  it('stops every process started by the cancelled session', async () => {
    const onClose = vi.fn();
    await render(createElement(ProcessCleanupModal, { processes: [process(), process({ processId: 'process-3', command: 'vite preview' })], onClose }));
    expect(document.body.textContent).toContain('本会话还有 2 个后台进程');
    await act(async () => { button('停止全部').click(); await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledWith('process-1', '/project');
    expect(stop).toHaveBeenCalledWith('process-3', '/project');
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the processes when the user chooses to leave them running', async () => {
    const onClose = vi.fn();
    await render(createElement(ProcessCleanupModal, { processes: [process()], onClose }));
    await act(async () => { button('保留运行').click(); });
    expect(stop).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
