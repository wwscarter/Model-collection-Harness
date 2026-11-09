// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxSettings } from '../../src/renderer/components/SandboxSettings';
import type { SandboxConfiguration } from '../../src/renderer/sandboxTypes';
import type { AmdApi } from '../../src/renderer/types';

let root: Root;
let container: HTMLDivElement;
let get: ReturnType<typeof vi.fn>;
let set: ReturnType<typeof vi.fn>;
let pickDirectory: ReturnType<typeof vi.fn>;
const configuration = (): SandboxConfiguration => ({ settings: { version: 1, network: 'allow', writableRoots: ['/workspace/cache'] }, status: { enabled: true, platform: 'darwin' } });
const render = async () => { await act(async () => { root.render(createElement(SandboxSettings)); }); };
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.includes(text))!;
const click = async (text: string) => { await act(async () => { button(text).click(); }); };
const network = async (value: string) => {
  await act(async () => {
    const control = container.querySelector<HTMLSelectElement>('[aria-label="命令网络策略"]')!;
    control.value = value; control.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const submit = async () => { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  get = vi.fn(async () => configuration());
  set = vi.fn(async (settings) => ({ ...configuration(), settings }));
  pickDirectory = vi.fn(async () => '/workspace/exports');
  window.amd = { sandbox: { get, set, pickDirectory } } as unknown as AmdApi;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete window.amd; });

describe('command sandbox settings', () => {
  it('renders the real platform availability and saves a changed network policy', async () => {
    await render();
    expect(container.querySelector('[aria-label="命令沙箱状态"]')!.textContent).toContain('已启用 · macOS');
    expect(button('保存沙箱设置').disabled).toBe(true);
    await network('loopback');
    expect(button('保存沙箱设置').disabled).toBe(false);
    await submit();
    expect(set).toHaveBeenCalledExactlyOnceWith({ version: 1, network: 'loopback', writableRoots: ['/workspace/cache'] });
    expect(container.textContent).toContain('新启动的命令使用此设置');
    expect(button('保存沙箱设置').disabled).toBe(true);
  });

  it('shows an unavailable platform with the detected reason', async () => {
    get.mockResolvedValueOnce({ ...configuration(), status: { enabled: false, platform: 'win32', reason: '此平台尚未提供命令沙箱' } });
    await render();
    expect(container.querySelector('[aria-label="命令沙箱状态"]')!.textContent).toContain('不可用 · Windows · 此平台尚未提供命令沙箱');
    expect(container.textContent).toContain('完全控制模式下仍然生效');
  });

  it('uses the native directory picker, deduplicates choices and removes an extra root', async () => {
    await render();
    await click('选择可写目录');
    await click('选择可写目录');
    expect(pickDirectory).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll('[aria-label="额外可写目录"] li')).toHaveLength(2);
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="移除可写目录 /workspace/cache"]')!.click(); });
    await submit();
    expect(set).toHaveBeenCalledExactlyOnceWith({ version: 1, network: 'allow', writableRoots: ['/workspace/exports'] });
  });

  it('retains the draft on save errors and retries without overwriting the saved state', async () => {
    await render();
    await network('deny');
    set.mockRejectedValueOnce(new Error('普通配置保存失败'));
    await submit();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('普通配置保存失败');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="命令网络策略"]')!.value).toBe('deny');
    expect(button('保存沙箱设置').disabled).toBe(false);
    await submit();
    expect(set.mock.calls[1][0].network).toBe('deny');
    expect(button('保存沙箱设置').disabled).toBe(true);
  });

  it('allows retrying a failed initial read before displaying editable settings', async () => {
    get.mockRejectedValueOnce(new Error('普通配置读取失败'));
    await render();
    expect(container.querySelector('form')).toBeNull();
    expect(set).not.toHaveBeenCalled();
    await click('重新读取');
    expect(get).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-label="命令网络策略"]')).not.toBeNull();
    expect(button('保存沙箱设置').disabled).toBe(true);
  });
});
