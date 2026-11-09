// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTrustSettings } from '../../src/renderer/components/ToolTrustSettings';
import type { ToolTrustApi, ToolTrustListing } from '../../src/renderer/toolTrustTypes';

let root: Root;
let container: HTMLDivElement;
let records: ToolTrustListing;
let get: ReturnType<typeof vi.fn<ToolTrustApi['get']>>;
let set: ReturnType<typeof vi.fn<ToolTrustApi['set']>>;
let api: ToolTrustApi;
const control = (name: string) => container.querySelector<HTMLSelectElement>('[aria-label="工具信任 ' + name + '"]')!;
const choose = async (name: string, value: string) => { await act(async () => { control(name).value = value; control(name).dispatchEvent(new Event('change', { bubbles: true })); }); };
const render = async () => { await act(async () => root.render(createElement(ToolTrustSettings, { api }))); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  records = { tools: [{ name: 'read', source: 'builtin' }, { name: 'mcp_documents_list', source: 'mcp', trust: 'ask' }, ...['run_command', 'write', 'edit'].map((name) => ({ name, source: 'builtin' }))], diagnostics: [] };
  get = vi.fn<ToolTrustApi['get']>(async () => structuredClone(records));
  set = vi.fn<ToolTrustApi['set']>(async (name, trust) => { records.tools = records.tools.map((tool) => tool.name === name ? { ...tool, trust } : tool); });
  api = { get, set };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('per-tool trust settings', () => {
  it('shows default policy separately from explicit ask and saves a chosen trust mode', async () => {
    await render();
    expect(control('read').value).toBe('default');
    expect(control('mcp_documents_list').value).toBe('ask');
    expect(container.querySelector('[aria-label="工具 read"]')!.textContent).toContain('内置工具');
    expect(container.querySelector('[aria-label="工具 mcp_documents_list"]')!.textContent).toContain('MCP 工具');
    await choose('mcp_documents_list', 'auto');
    expect(set).toHaveBeenCalledExactlyOnceWith('mcp_documents_list', 'auto');
    expect(control('mcp_documents_list').value).toBe('auto');
    await choose('read', 'disabled');
    expect(set).toHaveBeenLastCalledWith('read', 'disabled');
  });

  it('keeps automatic approval unavailable for command and file mutation tools', async () => {
    await render();
    for (const name of ['run_command', 'write', 'edit']) {
      expect(control(name).querySelector<HTMLOptionElement>('option[value="auto"]')!.disabled).toBe(true);
      expect(container.querySelector('[aria-label="工具 ' + name + '"]')!.textContent).toContain('执行权限模式控制');
    }
    expect(set).not.toHaveBeenCalled();
  });

  it('retains the current selection when a normal save fails', async () => {
    await render();
    set.mockRejectedValueOnce(new Error('普通信任设置保存失败'));
    await choose('mcp_documents_list', 'disabled');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('普通信任设置保存失败');
    expect(control('mcp_documents_list').value).toBe('ask');
  });

  it('shows loader diagnostics and supports retrying an initial error', async () => {
    records.diagnostics = ['普通工具目录暂时未更新。'];
    get.mockRejectedValueOnce(new Error('普通工具列表读取失败'));
    await render();
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '重新读取')!;
    await act(async () => retry.click());
    expect(container.querySelector('[aria-label="工具信任加载诊断"]')!.textContent).toContain('普通工具目录暂时未更新。');
    expect(control('read')).not.toBeNull();
  });
});
