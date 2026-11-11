// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileChangesBar } from '../../src/renderer/components/FileChangesBar';
import type { AmdApi, FileChangeRecord, FileRestoreResult } from '../../src/renderer/types';

let root: Root;
let container: HTMLDivElement;
let changes: FileChangeRecord[];
let listChanges: ReturnType<typeof vi.fn<(runId: string) => Promise<FileChangeRecord[]>>>;
let restore: ReturnType<typeof vi.fn<(runId: string, sessionId?: string) => Promise<FileRestoreResult>>>;

const buttons = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent?.trim() === text);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // antd Drawer/Popconfirm mount rc-resize-observer, which jsdom does not implement.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }),
  });
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  changes = [
    { runId: 'run-1', relativePath: 'src/a.ts', existed: true, beforeAvailable: true, createdAt: '2026-11-11T12:00:00.000Z' },
    { runId: 'run-1', relativePath: 'src/b.ts', existed: false, beforeAvailable: true, createdAt: '2026-11-11T12:00:01.000Z' },
  ];
  listChanges = vi.fn(async () => structuredClone(changes));
  restore = vi.fn(async () => {
    changes = changes.map((change) => ({ ...change, restoredAt: '2026-11-11T12:00:02.000Z' }));
    return { restored: ['src/a.ts', 'src/b.ts'], skipped: [] };
  });
  window.amd = { files: { changes: listChanges, restore } } as unknown as AmdApi;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.amd;
});

async function render() {
  await act(async () => {
    root.render(createElement(FileChangesBar, { sessionId: 'session-1', runId: 'run-1' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe('FileChangesBar', () => {
  it('lists the run changes and restores them after confirmation', async () => {
    await render();
    expect(document.body.textContent).toContain('本轮修改了 2 个文件');

    await act(async () => { buttons('查看文件')[0].click(); await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(document.body.textContent).toContain('src/a.ts');
    expect(document.body.textContent).toContain('src/b.ts');
    expect(document.body.textContent).toContain('撤销时删除此文件');

    await act(async () => { buttons('撤销本轮修改')[0].click(); await new Promise((resolve) => setTimeout(resolve, 50)); });
    // antd inserts a space between two Chinese characters; compare without whitespace.
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.replace(/\s+/g, '') === '撤销');
    expect(confirm).toBeTruthy();
    await act(async () => { confirm!.click(); await new Promise((resolve) => setTimeout(resolve, 50)); });

    expect(restore).toHaveBeenCalledWith('run-1', 'session-1');
    expect(document.body.textContent).toContain('已撤销 2 个文件');
    expect(document.body.textContent).not.toContain('本轮修改了 2 个文件');
  });

  it('reports skipped files and keeps them listed', async () => {
    restore.mockImplementationOnce(async () => {
      changes = changes.map((change) => ({ ...change, restoredAt: '2026-11-11T12:00:02.000Z' }));
      return { restored: ['src/a.ts'], skipped: [{ path: 'src/b.ts', reason: '本轮之后文件又被修改' }] };
    });
    await render();
    await act(async () => { buttons('撤销本轮修改')[0].click(); await new Promise((resolve) => setTimeout(resolve, 50)); });
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.replace(/\s+/g, '') === '撤销');
    await act(async () => { confirm!.click(); await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(document.body.textContent).toContain('已撤销 1 个文件，跳过 1 个');
    expect(document.body.textContent).toContain('本轮之后文件又被修改');
  });

  it('stays hidden while the run is still writing', async () => {
    await act(async () => {
      root.render(createElement(FileChangesBar, { sessionId: 'session-1', runId: 'run-1', running: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(listChanges).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('本轮修改了');
  });
});
