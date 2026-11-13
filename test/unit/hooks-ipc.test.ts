import { trustedIpcEvent } from '../helpers/trustedIpc';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookStore } from '../../src/core/hooks/HookStore';
import { TrustStore } from '../../src/core/security/TrustStore';
import { register, type HooksIpcContext } from '../../src/main/ipc/hooksIpc';

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, listener: (...args: any[]) => any) => state.handlers.set(channel, listener) } }));
const directories: string[] = [];
afterEach(() => { state.handlers.clear(); for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const config = { version: 1, hooks: [{ id: 'lint', event: 'run_start', run: 'npm run lint' }] };

function fixture(selected = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-hooks-ipc-')));
  directories.push(root);
  const trustPath = path.join(root, 'trust.json');
  const trustStore = new TrustStore(trustPath);
  const hookStore = new HookStore(path.join(root, 'agent'), trustStore);
  const ctx = { hookStore, trustStore, projects: { getRoot: () => selected ? root : undefined } } as unknown as HooksIpcContext;
  register(ctx);
  const invoke = async (name: string, ...args: unknown[]) => state.handlers.get('agent:hooks:' + name)!(trustedIpcEvent(), ...args);
  return { root, invoke, hookStore, trustPath };
}

describe('main process Hooks configuration', () => {
  it('round-trips the global configuration through the registered methods', async () => {
    const value = fixture(false);
    expect([...state.handlers.keys()]).toEqual(['agent:hooks:list', 'agent:hooks:save', 'agent:hooks:trust']);
    expect(await value.invoke('list')).toEqual({ diagnostics: [] });
    expect(await value.invoke('save', config)).toEqual(config);
    expect((await value.invoke('list')).global).toMatchObject({ config, trusted: true, path: path.join(value.root, 'agent', 'hooks.json') });
  });

  it('preserves the complete current project preview and grants only its refreshed content hash', async () => {
    const value = fixture();
    fs.mkdirSync(path.join(value.root, '.newai'));
    const file = path.join(value.root, '.newai', 'hooks.json');
    const content = JSON.stringify(config, null, 2) + '\n';
    fs.writeFileSync(file, content);
    const first = await value.invoke('list');
    expect(first.project).toMatchObject({ path: file, content, trusted: false, config });
    expect((await value.hookStore.load(value.root)).hooks).toEqual([]);
    fs.writeFileSync(file, content + '\n');
    await expect(value.invoke('trust', first.project.hash)).rejects.toThrow('Hooks 已变化');
    const current = await value.invoke('list');
    expect(await value.invoke('trust', current.project.hash)).toEqual({ success: true });
    expect((await value.invoke('list')).project.trusted).toBe(true);
    expect(new TrustStore(value.trustPath).isTrusted(value.root, '.newai/hooks.json', current.project.hash)).toBe(true);
  });

  it('validates incomplete settings and explains project selection before trust', async () => {
    const value = fixture(false);
    await expect(value.invoke('save', { version: 2, hooks: [] })).rejects.toThrow('Hooks 配置格式无效');
    await expect(value.invoke('trust', undefined)).rejects.toThrow('内容指纹无效');
    await expect(value.invoke('trust', 'a'.repeat(64))).rejects.toThrow('请先选择项目');
    expect(await value.invoke('list')).toEqual({ diagnostics: [] });
  });
});
