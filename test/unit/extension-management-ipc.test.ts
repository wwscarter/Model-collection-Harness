import { trustedIpcEvent } from '../helpers/trustedIpc';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillManager } from '../../src/core/agent/SkillManager';
import { ToolTrustStore } from '../../src/core/security/ToolTrustStore';
import type { MainContext } from '../../src/main/MainContext';
import { register as registerSkills } from '../../src/main/ipc/skillsIpc';
import { register as registerToolTrust } from '../../src/main/ipc/toolTrustIpc';

const native = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  showOpenDialog: vi.fn(),
  openPath: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, listener: (...args: any[]) => any) => native.handlers.set(channel, listener) },
  dialog: { showOpenDialog: native.showOpenDialog },
  shell: { openPath: native.openPath },
}));
const directories: string[] = [];
afterEach(() => {
  native.handlers.clear(); native.showOpenDialog.mockReset(); native.openPath.mockReset();
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-extension-ipc-')); directories.push(root); return root;
}
function invoke(channel: string, ...args: unknown[]) {
  return Promise.resolve(native.handlers.get(channel)!(trustedIpcEvent(), ...args));
}
function writeSkill(root: string, name: string, description = 'Ordinary project notes.') {
  const folder = path.join(root, name); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), ['---', 'name: ' + name, 'description: ' + description, '---', 'Use readable notes.'].join(String.fromCharCode(10)));
  return folder;
}

describe('extension management IPC', () => {
  it('keeps disabled skills visible and round-trips the folder identity', async () => {
    const manager = new SkillManager(directory());
    writeSkill(manager.skillsDir, 'plain-notes');
    registerSkills({ skillManager: manager, getWindow: () => null } as unknown as MainContext);
    const initial = await invoke('agent:skills:list');
    expect(initial.skills).toMatchObject([{ id: 'plain-notes', name: 'plain-notes', enabled: true }]);
    await invoke('agent:skills:set-enabled', 'plain-notes', false);
    expect((await invoke('agent:skills:list')).skills).toMatchObject([{ id: 'plain-notes', enabled: false }]);
    await invoke('agent:skills:set-enabled', 'plain-notes', true);
    expect((await invoke('agent:skills:list')).skills[0].enabled).toBe(true);
    native.openPath.mockResolvedValue('');
    expect(await invoke('agent:skills:open-directory')).toEqual({ success: true });
    expect(native.openPath).toHaveBeenCalledExactlyOnceWith(manager.skillsDir);
  });

  it('copies an ordinary selected skill only after its preview is confirmed', async () => {
    const manager = new SkillManager(directory());
    const source = writeSkill(directory(), 'format-notes');
    fs.writeFileSync(path.join(source, 'reference.txt'), 'Ordinary supporting material.');
    registerSkills({ skillManager: manager, getWindow: () => null } as unknown as MainContext);
    native.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] });
    const pending = await invoke('agent:skills:preview-import');
    expect(pending.preview).toMatchObject({ name: 'format-notes', fileCount: 2 });
    expect(fs.existsSync(path.join(manager.skillsDir, 'format-notes'))).toBe(false);
    expect(pending).not.toHaveProperty('source');
    await invoke('agent:skills:confirm-import', pending.token);
    expect(fs.readFileSync(path.join(manager.skillsDir, 'format-notes/reference.txt'), 'utf8')).toBe('Ordinary supporting material.');
    expect((await invoke('agent:skills:list')).skills[0]).toMatchObject({ id: 'format-notes', enabled: true });
    native.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await invoke('agent:skills:preview-import')).toBeUndefined();
  });

  it('lists project tools before project selection and merges MCP choices with their source', async () => {
    const file = path.join(directory(), 'tool-trust.json');
    const toolTrust = new ToolTrustStore(file);
    toolTrust.set('mcp__manual__lookup', 'ask');
    const describe = vi.fn(async () => ({ tools: ['read', 'web_search', 'web_fetch', 'remember', 'recall', 'forget'] }));
    registerToolTrust({ toolTrust, agentRuntime: { describe }, mcpTools: new Map([['ordinary-server', ['mcp__ordinary__greet']]]) } as unknown as MainContext);
    const listing = await invoke('agent:tool-trust:get');
    expect(listing.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['ls', 'grep', 'find', 'write', 'edit', 'run_command', 'code_symbols', 'code_search', 'stop_process']));
    expect(listing.tools.find((tool: { name: string }) => tool.name === 'ls').source).toBe('builtin');
    expect(listing.tools.find((tool: { name: string }) => tool.name === 'mcp__ordinary__greet').source).toBe('mcp');
    expect(listing.tools.find((tool: { name: string }) => tool.name === 'mcp__manual__lookup')).toMatchObject({ trust: 'ask', source: 'mcp' });
    await invoke('agent:tool-trust:set', 'mcp__ordinary__greet', 'disabled');
    const updated = await invoke('agent:tool-trust:get');
    expect(updated.tools.find((tool: { name: string }) => tool.name === 'mcp__ordinary__greet').trust).toBe('disabled');
    expect(new ToolTrustStore(file).get('mcp__ordinary__greet')).toBe('disabled');
  });
});
