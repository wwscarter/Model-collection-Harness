// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CodeSearchSettings } from '../../src/renderer/components/CodeSearchSettings';
import type { AmdApi } from '../../src/renderer/types';

it('saves explicit local search settings and probes without saving the draft', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const config = { version: 1 as const, enabled: false, model: 'local-embedding', timeoutMs: 10000, maxFiles: 5000, maxChunks: 10000, topK: 8 };
  const configuration = { config, baseURL: 'http://127.0.0.1:11434', status: { status: 'disabled', hits: [], indexedFiles: 0, indexedChunks: 0, truncated: false } };
  const save = vi.fn(async (next) => ({ ...configuration, config: next }));
  const probe = vi.fn(async () => ({ model: config.model, digest: 'fixture' }));
  const reindex = vi.fn(async () => ({ files: 3, symbols: 8, durationMs: 10, truncated: false }));
  window.amd = { codebase: { get: async () => configuration, set: save, probe, reindex } } as unknown as AmdApi;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(CodeSearchSettings)); });
    expect(container.textContent).toContain(configuration.baseURL);
    const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!;
    await act(async () => { button('检测模型').click(); });
    expect(probe).toHaveBeenCalledWith({ ...config, enabled: true });
    expect(save).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLInputElement>('[aria-label="启用本机语义检索"]')!.click(); });
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(save).toHaveBeenCalledWith({ ...config, enabled: true });
    await act(async () => { button('更新当前项目索引').click(); });
    expect(reindex).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('3 个文件，8 个符号');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove(); delete window.amd;
  }
});
