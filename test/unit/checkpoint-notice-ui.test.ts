// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionCheckpointNotice } from '../../src/renderer/components/SessionCheckpointNotice';
import type { AmdApi, RunCheckpoint } from '../../src/renderer/types';

let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof vi.fn<(sessionId: string) => Promise<RunCheckpoint | undefined>>>;
let acknowledge: ReturnType<typeof vi.fn<(runId: string) => Promise<{ success: boolean }>>>;

const checkpoint: RunCheckpoint = {
  runId: 'run-1', sessionId: 'session-1', prompt: 'fix',
  status: 'interrupted', toolCalls: 3, modifiedFiles: ['src/a.ts', 'src/b.ts'],
  lastTool: 'write', startedAt: '2026-11-11T12:00:00.000Z', updatedAt: '2026-11-11T12:01:00.000Z',
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  latest = vi.fn(async () => structuredClone(checkpoint));
  acknowledge = vi.fn(async () => ({ success: true }));
  window.amd = { checkpoints: { latest, acknowledge } } as unknown as AmdApi;
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
  await act(async () => { root.render(createElement(SessionCheckpointNotice, { sessionId: 'session-1' })); await new Promise((resolve) => setTimeout(resolve, 20)); });
}

describe('SessionCheckpointNotice', () => {
  it('reports an interrupted run and acknowledges it on dismissal', async () => {
    await render();
    expect(latest).toHaveBeenCalledWith('session-1');
    expect(document.body.textContent).toContain('上次任务在 3 次工具操作后中断');
    expect(document.body.textContent).toContain('已修改 2 个文件：src/a.ts、src/b.ts');
    expect(document.body.textContent).toContain('系统不会自动重放');
    const dismiss = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.replace(/\s+/g, '') === '知道了')!;
    await act(async () => { dismiss.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(acknowledge).toHaveBeenCalledWith('run-1');
    expect(document.body.textContent).not.toContain('上次任务在');
  });

  it('stays hidden for completed or missing runs', async () => {
    latest.mockResolvedValueOnce({ ...checkpoint, status: 'completed' });
    await render();
    expect(document.body.textContent).not.toContain('上次任务');
    expect(document.body.querySelector('.ant-alert')).toBeNull();
  });
});
