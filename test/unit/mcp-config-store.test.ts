import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpConfigStore, MCP_SECRET_MASK } from '../../src/core/agent/McpConfigStore';
import { configureEncryptionKeyProvider, resetEncryptionKeyProvider } from '../../src/utils/crypto';

const directories: string[] = [];
beforeEach(() => configureEncryptionKeyProvider(() => Buffer.alloc(32, 7)));
afterEach(() => { resetEncryptionKeyProvider(); for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-mcp-config-')); directories.push(root); return new McpConfigStore(root); }
const stdio = { type: 'stdio', command: 'node', args: ['ordinary-server.js'], env: { APP_TOKEN: 'synthetic-local-only', APP_MODE: 'development' }, enabled: true };
const http = { type: 'http', url: 'http://127.0.0.1:34567/mcp', headers: { Authorization: 'Bearer synthetic-only', 'X-Environment': 'synthetic-environment-only' } };

describe('encrypted MCP configuration', () => {
  it('starts empty and saves masked stdio and HTTP views while encrypting every map value', () => {
    const store = fixture();
    expect(store.list().servers).toEqual([]);
    expect(store.save('local-tools', stdio).config).toMatchObject({ env: { APP_TOKEN: MCP_SECRET_MASK, APP_MODE: MCP_SECRET_MASK } });
    expect(store.save('local-http', http).config).toMatchObject({ headers: { Authorization: MCP_SECRET_MASK, 'X-Environment': MCP_SECRET_MASK } });
    const disk = fs.readFileSync(store.filePath, 'utf8');
    for (const secret of [...Object.values(stdio.env), ...Object.values(http.headers)]) expect(disk).not.toContain(secret);
    const saved = JSON.parse(disk);
    expect(saved.mcpServers['local-tools'].env.APP_MODE).toEqual({ $encrypted: expect.any(String) });
    expect(saved.mcpServers['local-http'].headers.Authorization).toEqual({ $encrypted: expect.any(String) });
    expect(new McpConfigStore(path.dirname(store.filePath)).load()).toMatchObject({ servers: [{ name: 'local-tools', scope: 'global', config: stdio }, { name: 'local-http', config: http }], errors: [] });
  });

  it('keeps masked values, clears blank or removed keys, and replaces edited credentials', () => {
    const store = fixture();
    store.save('local-tools', stdio);
    const view = store.list().servers[0];
    store.save(view.name, { ...view.config, env: { APP_TOKEN: MCP_SECRET_MASK, APP_MODE: '' } });
    expect(store.load().servers[0].config).toMatchObject({ env: { APP_TOKEN: stdio.env.APP_TOKEN } });
    expect((store.load().servers[0].config as { env: object }).env).not.toHaveProperty('APP_MODE');
    store.save(view.name, { ...view.config, env: { APP_MODE: 'synthetic replacement' } });
    expect(store.load().servers[0].config).toMatchObject({ env: { APP_MODE: 'synthetic replacement' } });
    expect((store.load().servers[0].config as { env: object }).env).not.toHaveProperty('APP_TOKEN');
  });

  it('retains ordinary optional transport fields and valid environment and header names', () => {
    const store = fixture();
    store.save('local-tools', { ...stdio, cwd: '.', timeout: 20, exposure: 'direct', toolExposure: { 'docs_*': 'deferred' }, description: 'Local project tools', env: { _CACHE1: 'synthetic cache setting' } });
    store.save('local-http', { ...http, url: http.url + '?region=local', headers: { 'X-App-Mode': 'synthetic app mode' }, oauth: { clientId: 'local-client', callbackUrl: 'http://127.0.0.1:45678/callback', callbackPort: 45678, clientRegistration: 'dcr', scope: 'docs', clientName: 'local app', authServerMetadataUrl: 'https://example.test/metadata' } });
    expect(store.load().errors).toEqual([]);
    expect(store.load().servers[0].config).toMatchObject({ cwd: '.', timeout: 20, exposure: 'direct', toolExposure: { 'docs_*': 'deferred' }, env: { _CACHE1: 'synthetic cache setting' } });
    expect(store.load().servers[1].config).toMatchObject({ url: http.url + '?region=local', headers: { 'X-App-Mode': 'synthetic app mode' }, oauth: { clientRegistration: 'dcr' } });
  });

  it('reads legacy hand-written servers and encrypts their credentials when configuration is saved', () => {
    const store = fixture();
    fs.writeFileSync(store.filePath, '\uFEFF' + JSON.stringify({ autoEnableCodemode: false, note: 'hand-written config', mcpServers: { legacy: { command: 'node', args: ['legacy.js'], env: { APP_MODE: 'synthetic legacy' }, exposure: 'codemode-deferred' } } }));
    expect(store.list().servers[0].config).toMatchObject({ type: 'stdio', exposure: 'codemode', env: { APP_MODE: MCP_SECRET_MASK } });
    expect(store.loadConfig()).toMatchObject({ autoEnableCodemode: false, servers: [{ name: 'legacy', config: { env: { APP_MODE: 'synthetic legacy' } } }], errors: [] });
    store.save('local-http', http);
    const disk = fs.readFileSync(store.filePath, 'utf8');
    expect(disk).not.toContain('synthetic legacy');
    expect(JSON.parse(disk)).toMatchObject({ autoEnableCodemode: false, note: 'hand-written config' });
  });

  it('encrypts and masks a configured OAuth client secret along with headers', () => {
    const store = fixture();
    store.save('oauth-local', { ...http, oauth: { clientId: 'local-client', clientSecret: 'synthetic oauth secret', callbackPort: 45678 } });
    expect(store.list().servers[0].config).toMatchObject({ oauth: { clientSecret: MCP_SECRET_MASK } });
    expect(fs.readFileSync(store.filePath, 'utf8')).not.toContain('synthetic oauth secret');
    expect(store.load().servers[0].config).toMatchObject({ oauth: { clientSecret: 'synthetic oauth secret' } });
  });

  it('keeps unavailable credentials masked and leaves their server out of runtime loading', () => {
    const store = fixture();
    store.save('local-http', http);
    configureEncryptionKeyProvider(() => { throw new Error('synthetic credential store unavailable'); });
    expect(store.list().servers[0]).toMatchObject({ config: { headers: { Authorization: MCP_SECRET_MASK } }, error: 'MCP 凭据解密失败，请重新输入对应值' });
    expect(store.load()).toMatchObject({ servers: [], errors: [expect.stringContaining('凭据解密失败')] });
    expect(JSON.stringify(store.list())).not.toContain(http.headers.Authorization);
  });

  it('removes one server and retains the remaining encrypted configuration', () => {
    const store = fixture();
    store.save('local-tools', stdio); store.save('local-http', http);
    expect(store.remove('local-tools')).toBe(true);
    expect(store.remove('local-tools')).toBe(false);
    expect(store.list().servers.map((server) => server.name)).toEqual(['local-http']);
    expect(store.load().servers[0].config).toEqual(http);
  });

  it('reports ordinary incomplete JSON or missing transport settings without exposing document text', () => {
    const store = fixture();
    fs.writeFileSync(store.filePath, '{');
    expect(store.list()).toMatchObject({ servers: [], diagnostics: ['MCP 配置 JSON 格式无效'] });
    expect(store.load()).toEqual({ servers: [], errors: ['MCP 配置 JSON 格式无效'] });
    fs.writeFileSync(store.filePath, JSON.stringify({ mcpServers: { incomplete: { enabled: true } } }));
    expect(store.list().diagnostics).toEqual(['incomplete：MCP 命令无效']);
    expect(() => store.save('new-local', { enabled: true })).toThrow('命令无效');
  });

  it('fails a save before overwriting the previous file when encryption is unavailable', () => {
    const store = fixture();
    store.save('local-tools', stdio);
    const before = fs.readFileSync(store.filePath, 'utf8');
    configureEncryptionKeyProvider(() => { throw new Error('synthetic credential store unavailable'); });
    expect(() => store.save('local-http', http)).toThrow('synthetic credential store unavailable');
    expect(fs.readFileSync(store.filePath, 'utf8')).toBe(before);
  });
});
