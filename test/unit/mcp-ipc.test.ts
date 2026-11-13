import { trustedIpcEvent } from '../helpers/trustedIpc';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpConfigStore } from '../../src/core/agent/McpConfigStore';
import { testMcpConnection } from '../../src/core/agent/McpTransport';
import { register } from '../../src/main/ipc/mcpIpc';
import { appendMcpLog, readMcpLog } from '../../src/main/mcpRuntime';
import type { MainContext } from '../../src/main/MainContext';
import { configureEncryptionKeyProvider, resetEncryptionKeyProvider } from '../../src/utils/crypto';

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), confirm: vi.fn(async () => true) }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, listener: (...args: any[]) => any) => state.handlers.set(channel, listener) } }));
vi.mock('../../src/main/approvalPrompt', () => ({ confirmCommand: state.confirm }));
const directories: string[] = [];
let server: http.Server;
let url: string;
let methods: string[] = [];
let offeredTools = ['greet'];
beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/unavailable') { response.writeHead(503); response.end('ordinary maintenance'); return; }
      const message = JSON.parse(body);
      methods.push(message.method);
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ordinary-fixture', version: '1' } }
        : { tools: offeredTools.map((name) => ({ name, description: 'Ordinary reference tool', inputSchema: { type: 'object', properties: {} } })) };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterAll(() => { server.closeAllConnections(); server.close(); });
beforeEach(() => { methods = []; offeredTools = ['greet']; state.confirm.mockResolvedValue(true); configureEncryptionKeyProvider(() => Buffer.alloc(32, 6)); });
afterEach(() => { state.handlers.clear(); state.confirm.mockClear(); resetEncryptionKeyProvider(); for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-mcp-host-')));
  directories.push(root);
  const agentDir = path.join(root, 'agent');
  const mcpConfig = new McpConfigStore(agentDir);
  const ctx = { mcpConfig, agentRuntime: { agentDir }, projects: { getRoot: () => root }, workspaceRoot: root, mcpTools: new Map(), commandSandbox: { settings: { version: 1, network: 'allow', writableRoots: [] } } } as unknown as MainContext;
  register(ctx);
  const invoke = (name: string, ...args: unknown[]) => Promise.resolve(state.handlers.get('agent:mcp:' + name)!(trustedIpcEvent(), ...args));
  return { root, ctx, invoke, mcpConfig };
}

describe('MCP settings host integration', () => {
  it('stores SDK-compatible identifiers for ordinary formatted tool names', async () => {
    const value = fixture();
    offeredTools = ['read-file', 'sum.total', 'docs/list'];
    await value.invoke('save', 'local-docs', { type: 'http', url, enabled: true });
    expect(await value.invoke('test', 'local-docs')).toMatchObject({ success: true, tools: 3 });
    expect(value.ctx.mcpTools.get('local-docs')).toEqual(['mcp__local_docs__read_file', 'mcp__local_docs__sum_total', 'mcp__local_docs__docs_list']);
  });
  it('saves, lists, connects, tracks tools and removes an ordinary HTTP server', async () => {
    const value = fixture();
    expect((await value.invoke('list')).servers).toEqual([]);
    await value.invoke('save', 'local-docs', { type: 'http', url, enabled: true });
    expect(await value.invoke('test', 'local-docs')).toMatchObject({ success: true, tools: 1 });
    expect(methods).toContain('initialize');
    expect(methods).toContain('tools/list');
    expect(value.ctx.mcpTools.get('local-docs')).toEqual(['mcp__local_docs__greet']);
    await value.invoke('save', 'local-docs', { type: 'http', url, enabled: false });
    expect(value.ctx.mcpTools.has('local-docs')).toBe(false);
    expect((await value.invoke('list')).servers[0].config.enabled).toBe(false);
    expect(await value.invoke('remove', 'local-docs')).toEqual({ success: true });
    expect((await value.invoke('list')).servers).toEqual([]);
  });

  it('initializes and lists an ordinary stdio server after host confirmation', async () => {
    const value = fixture();
    const file = path.join(value.root, 'server.mjs');
    fs.writeFileSync(file, [
      "import readline from 'node:readline';",
      "readline.createInterface({input:process.stdin}).on('line', line => {",
      'const request = JSON.parse(line); if (request.id === undefined) return;',
      "const result = request.method === 'initialize' ? {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'ordinary',version:'1'}} : {tools:[{name:'greet',inputSchema:{type:'object',properties:{}}}]};",
      'process.stdout.write(JSON.stringify({jsonrpc: "2.0", id:request.id,result}) + String.fromCharCode(10));',
      '});',
    ].join('\n'));
    await value.invoke('save', 'local-process', { type: 'stdio', command: process.execPath, args: [file] });
    expect(await value.invoke('test', 'local-process')).toMatchObject({ success: true, tools: 1, sandbox: { network: 'allow' } });
    expect(state.confirm).toHaveBeenCalledTimes(1);
    state.confirm.mockResolvedValue(false);
    expect(await value.invoke('test', 'local-process')).toEqual({ success: false, error: '用户未批准 MCP 服务器连接' });
  });

  it('reports an unavailable service and completes cancelled connection requests', async () => {
    const value = fixture();
    await value.invoke('save', 'maintenance', { type: 'http', url: url + '/unavailable' });
    expect(await value.invoke('test', 'maintenance')).toMatchObject({ success: false, error: expect.stringContaining('503') });
    const controller = new AbortController(); controller.abort();
    await expect(testMcpConnection({ entry: value.mcpConfig.load().servers[0], cwd: value.root }, controller.signal)).rejects.toThrow();
  });

  it('returns the latest 200 complete log lines and keeps partial lines until completed', async () => {
    const value = fixture();
    value.mcpConfig.save('local', { type: 'http', url });
    const entry = value.mcpConfig.load().servers[0];
    appendMcpLog(value.ctx, entry, Array.from({ length: 205 }, (_, index) => 'ordinary status ' + index).join('\n') + '\n');
    expect(readMcpLog(value.ctx)).toHaveLength(200);
    expect(readMcpLog(value.ctx)[0]).toContain('ordinary status 5');
    appendMcpLog(value.ctx, entry, 'connection rea');
    expect(readMcpLog(value.ctx).at(-1)).toContain('ordinary status 204');
    appendMcpLog(value.ctx, entry, 'dy\n');
    expect((await value.invoke('log')).at(-1)).toBe('[local] connection ready');
  });
});
