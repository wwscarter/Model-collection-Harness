// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSettings } from '../../src/renderer/components/McpSettings';
import type { McpApi, McpListing } from '../../src/renderer/mcpTypes';

let root: Root;
let container: HTMLDivElement;
let records: McpListing;
let list: ReturnType<typeof vi.fn<McpApi['list']>>;
let save: ReturnType<typeof vi.fn<McpApi['save']>>;
let remove: ReturnType<typeof vi.fn<McpApi['remove']>>;
let testConnection: ReturnType<typeof vi.fn<McpApi['test']>>;
let log: ReturnType<typeof vi.fn<McpApi['log']>>;
let api: McpApi;
const button = (name: string, scope: ParentNode = container) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === name)!;
const click = async (name: string, scope: ParentNode = container) => { await act(async () => button(name, scope).click()); };
const field = (label: string) => container.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-label="' + label + '"]')!;
const input = async (label: string, value: string) => { await act(async () => { const control = field(label); const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value); control.dispatchEvent(new Event('input', { bubbles: true })); }); };
const select = async (type: string) => { await act(async () => { const control = container.querySelector<HTMLSelectElement>('[aria-label="MCP 传输方式"]')!; control.value = type; control.dispatchEvent(new Event('change', { bubbles: true })); }); };
const render = async () => { await act(async () => root.render(createElement(McpSettings, { api }))); };
const server = () => container.querySelector('[aria-label="MCP 服务器 documents"]')!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  records = { path: '/agent/mcp.json', servers: [{ name: 'documents', config: { type: 'stdio', command: 'node', args: ['ordinary-server.mjs'], env: { CONFIG_VALUE: '••••••', OPTIONAL_VALUE: '••••••' }, enabled: true, exposure: 'deferred', description: '普通文档列表' } }], diagnostics: [] };
  list = vi.fn<McpApi['list']>(async () => structuredClone(records));
  save = vi.fn<McpApi['save']>(async (name, config) => { records.servers = [...records.servers.filter((entry) => entry.name !== name), { name, config }]; });
  remove = vi.fn<McpApi['remove']>(async (name) => { records.servers = records.servers.filter((entry) => entry.name !== name); });
  testConnection = vi.fn<McpApi['test']>(async () => ({ success: true, tools: 4 }));
  log = vi.fn<McpApi['log']>(async () => ['ordinary start', 'ordinary ready']);
  api = { list, save, remove, test: testConnection, log };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('MCP server settings', () => {
  it('edits a masked stdio server while retaining unrelated configuration fields', async () => {
    await render(); await click('编辑', server());
    expect(field('MCP 服务器名称').disabled).toBe(true);
    expect(field('MCP 环境变量或请求头').value).toContain('••••••');
    await input('MCP 命令参数', '["updated-server.mjs", "--local"]');
    await input('MCP 环境变量或请求头', '{"CONFIG_VALUE":"••••••","OPTIONAL_VALUE":""}');
    await click('保存 MCP 服务器');
    expect(save).toHaveBeenCalledExactlyOnceWith('documents', expect.objectContaining({ type: 'stdio', command: 'node', args: ['updated-server.mjs', '--local'], env: { CONFIG_VALUE: '••••••', OPTIONAL_VALUE: '' }, exposure: 'deferred', description: '普通文档列表', enabled: true }));
    expect(container.querySelector('[aria-label="编辑 MCP 服务器"]')).toBeNull();
  });

  it('adds an HTTP server with header fields and an explicit enabled choice', async () => {
    await render(); await click('添加服务器');
    await input('MCP 服务器名称', 'local-http'); await select('http');
    await input('MCP HTTP 地址', 'http://127.0.0.1:3000/mcp');
    await input('MCP 环境变量或请求头', '{"X-Local-Mode":"ordinary"}');
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="启用 MCP 服务器"]')!.click());
    await click('保存 MCP 服务器');
    expect(save).toHaveBeenCalledExactlyOnceWith('local-http', { type: 'http', url: 'http://127.0.0.1:3000/mcp', headers: { 'X-Local-Mode': 'ordinary' }, enabled: false });
  });

  it('shows connection tool counts, failures and the most recent log lines', async () => {
    await render(); await click('测试连接', server());
    expect(testConnection).toHaveBeenCalledExactlyOnceWith('documents');
    expect(container.textContent).toContain('4 个工具');
    testConnection.mockResolvedValueOnce({ success: false, error: '普通服务尚未启动' });
    await click('测试连接', server());
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('普通服务尚未启动');
    log.mockResolvedValueOnce(Array.from({ length: 210 }, (_, index) => 'ordinary log ' + index));
    await click('读取日志');
    expect(container.querySelector('[aria-label="MCP 日志内容"]')!.textContent!.split('\n')).toHaveLength(200);
    expect(container.querySelector('[aria-label="MCP 日志内容"]')!.textContent).toContain('ordinary log 209');
  });

  it('preserves an unsaved draft after a normal configuration save failure', async () => {
    await render(); await click('编辑', server());
    await input('MCP 启动命令', 'ordinary-node');
    save.mockRejectedValueOnce(new Error('普通 MCP 配置保存失败'));
    await click('保存 MCP 服务器');
    expect(field('MCP 启动命令').value).toBe('ordinary-node');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('普通 MCP 配置保存失败');
    await input('MCP 命令参数', '{invalid ordinary draft');
    await click('保存 MCP 服务器');
    expect(save).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('JSON 数组');
  });

  it('removes a configured server and renders ordinary loading diagnostics', async () => {
    records.diagnostics = ['普通服务器描述尚未填写。'];
    await render();
    expect(container.querySelector('[aria-label="MCP 加载诊断"]')!.textContent).toContain('普通服务器描述尚未填写。');
    await click('删除', server());
    expect(remove).toHaveBeenCalledExactlyOnceWith('documents');
    expect(server()).toBeNull();
  });
});
