import { trustedIpcEvent } from '../helpers/trustedIpc';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RulesLoader } from '../../src/core/agent/RulesLoader';
import { TrustStore } from '../../src/core/security/TrustStore';
import type { MainContext } from '../../src/main/MainContext';
import { register } from '../../src/main/ipc/rulesIpc';

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, listener: (...args: any[]) => any) => state.handlers.set(channel, listener) } }));

const directories: string[] = [];
afterEach(() => { state.handlers.clear(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(selected = true) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-rules-ipc-')));
  directories.push(directory);
  const projectRoot = path.join(directory, 'project');
  fs.mkdirSync(projectRoot);
  const trustPath = path.join(directory, 'trust.json');
  const trustStore = new TrustStore(trustPath);
  const rulesLoader = new RulesLoader({ agentDir: path.join(directory, 'agent'), trustStore });
  const ctx = { rulesLoader, trustStore, projects: { getRoot: () => selected ? projectRoot : undefined } } as unknown as MainContext;
  register(ctx);
  const invoke = async (name: string, ...args: unknown[]) => state.handlers.get('agent:rules:' + name)!(trustedIpcEvent(), ...args);
  return { projectRoot, rulesLoader, trustPath, invoke };
}

describe('main process rules configuration', () => {
  it('registers all five methods and persists normal global edits and enabled states', async () => {
    const value = fixture(false);
    expect([...state.handlers.keys()]).toEqual(['agent:rules:list', 'agent:rules:save', 'agent:rules:set-enabled', 'agent:rules:remove', 'agent:rules:trust']);
    expect(await value.invoke('list')).toMatchObject({ global: [], project: [], diagnostics: [], truncated: false });
    await value.invoke('save', { name: '工作约定.md', content: '先说明结果。', enabled: true });
    expect((await value.invoke('list')).global).toMatchObject([{ name: '工作约定', content: '先说明结果。', enabled: true, trusted: true }]);
    await value.invoke('set-enabled', '工作约定', false);
    expect((await value.invoke('list')).global[0].enabled).toBe(false);
    expect((await value.rulesLoader.load()).rules).toEqual([]);
    expect(await value.invoke('remove', '工作约定')).toEqual({ success: true });
    expect((await value.invoke('list')).global).toEqual([]);
  });

  it('previews the complete project rule before an explicit grant and requires a fresh hash after editing', async () => {
    const value = fixture();
    const file = path.join(value.projectRoot, 'AGENTS.md');
    const content = '完成改动后说明相关验证结果。\n';
    fs.writeFileSync(file, content);
    const before = await value.invoke('list');
    expect(before.project).toMatchObject([{ path: file, content, trusted: false }]);
    expect(before.diagnostics).toContain('项目规则尚未信任：AGENTS.md');
    expect((await value.rulesLoader.load({ projectRoot: value.projectRoot })).rules).toEqual([]);
    fs.writeFileSync(file, content + '保持与现有项目风格一致。\n');
    await expect(value.invoke('trust', file, before.project[0].hash)).rejects.toThrow('规则内容已变化');
    const current = await value.invoke('list');
    expect(await value.invoke('trust', file, current.project[0].hash)).toMatchObject({ trusted: true, hash: current.project[0].hash });
    expect((await value.invoke('list')).project[0].trusted).toBe(true);
    expect(new TrustStore(value.trustPath).isTrusted(value.projectRoot, 'AGENTS.md', current.project[0].hash)).toBe(true);
    expect((await value.rulesLoader.load({ projectRoot: value.projectRoot })).rules[0].content).toBe(current.project[0].content);
  });

  it('merges load and final prompt limit diagnostics while retaining the full preview', async () => {
    const value = fixture(false);
    const content = '遵守项目工作约定。'.repeat(1_000);
    await value.invoke('save', { name: 'long-conventions', content, enabled: true });
    const listing = await value.invoke('list');
    expect(listing).toMatchObject({ truncated: true });
    expect(listing.global[0].content).toBe(content);
    expect(listing.diagnostics.some((diagnostic: string) => diagnostic.includes('规则超出 8000'))).toBe(true);
    expect(listing.diagnostics.some((diagnostic: string) => diagnostic.includes('规则片段达到 8000'))).toBe(true);
    expect(listing.diagnostics).toContain('规则注入片段总上限为 8000 字符（包含来源标记）；超出的内容已截断或省略，预览仍显示完整规则。');
    expect(new Set(listing.diagnostics).size).toBe(listing.diagnostics.length);
  });

  it('validates ordinary missing or mistyped configuration values in the host', async () => {
    const value = fixture(false);
    await expect(value.invoke('save', undefined)).rejects.toThrow('规则参数无效');
    await expect(value.invoke('save', { name: 'conventions', enabled: true })).rejects.toThrow('内容必须');
    await expect(value.invoke('save', { name: 'conventions', content: '说明结果。', enabled: 'yes' })).rejects.toThrow('启用状态无效');
    await expect(value.invoke('set-enabled', 'conventions', undefined)).rejects.toThrow('启用状态无效');
    await expect(value.invoke('remove', undefined)).rejects.toThrow('规则名称无效');
    await expect(value.invoke('trust', undefined, undefined)).rejects.toThrow('文件参数无效');
    expect(await value.invoke('list')).toMatchObject({ global: [], project: [] });
  });
});
