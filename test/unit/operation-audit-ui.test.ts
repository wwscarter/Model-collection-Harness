// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationAuditPanel } from '../../src/renderer/components/OperationAuditPanel';
import type { AmdApi, OperationAuditEntry } from '../../src/renderer/types';

let root: Root;
let container: HTMLDivElement;
let audit: ReturnType<typeof vi.fn<(limit?: number) => Promise<OperationAuditEntry[]>>>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }),
  });
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  audit = vi.fn(async () => [
    { sequence: 2, timestamp: '2026-11-11T12:00:00.000Z', type: 'file.write', actor: 'agent', result: 'success', path: 'src/a.ts', runId: 'run-1' },
    { sequence: 1, timestamp: '2026-11-11T11:59:00.000Z', type: 'command.execute', actor: 'user', result: 'failed', command: 'npm test', detail: '退出码 1' },
  ]);
  window.amd = { operationAudit: audit } as unknown as AmdApi;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.amd;
});

describe('OperationAuditPanel', () => {
  it('opens the trail and renders file and command operations', async () => {
    await act(async () => { root.render(createElement(OperationAuditPanel)); });
    const trigger = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes('操作审计'))!;
    await act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(audit).toHaveBeenCalledWith(200);
    expect(document.body.textContent).toContain('文件写入');
    expect(document.body.textContent).toContain('命令执行');
    expect(document.body.textContent).toContain('src/a.ts');
    expect(document.body.textContent).toContain('npm test');
    expect(document.body.textContent).toContain('失败');
  });

  it('shows an empty state before any operation is recorded', async () => {
    audit.mockResolvedValueOnce([]);
    await act(async () => { root.render(createElement(OperationAuditPanel)); });
    const trigger = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes('操作审计'))!;
    await act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(document.body.textContent).toContain('还没有操作记录');
  });
});
