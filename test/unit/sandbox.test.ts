import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBubblewrapArgs, buildMacSandboxProfile, createSandboxPolicy, getSandboxStatus, sandboxFailureNotice, wrapCommand } from '../../src/core/security/Sandbox';
import { DEFAULT_SANDBOX_SETTINGS, loadSandboxSettings, saveSandboxSettings, validateSandboxSettings } from '../../src/core/security/SandboxSettings';
import { CommandExecutor } from '../../src/core/tty/CommandExecutor';
import { ProjectProcessManager } from '../../src/core/tty/ProjectProcessManager';

const directories: string[] = [];
function project(): string { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai sandbox-')); directories.push(directory); return fs.realpathSync(directory); }
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const quote = (value: string) => process.platform === 'win32' ? '"' + value.replaceAll('"', '""') + '"' : String.fromCharCode(39) + value.replaceAll(String.fromCharCode(39), String.fromCharCode(39, 34, 39, 34, 39)) + String.fromCharCode(39);

describe('OS command sandbox policy', () => {
  it('generates an inspectable macOS profile with project/cache writes and credential read restrictions', () => {
    const root = project();
    const policy = createSandboxPolicy(root);
    const profile = buildMacSandboxProfile(policy);
    expect(policy.writableRoots).toContain(root);
    expect(policy.writableRoots).toContain(fs.realpathSync(os.tmpdir()));
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(subpath ' + JSON.stringify(root) + ')');
    expect(profile).toContain('(deny file-read*');
    expect(profile).toContain('.ssh');
    expect(profile).toContain('.aws');
    expect(profile).toContain('Library/Keychains');
    expect(buildMacSandboxProfile({ ...policy, network: 'deny' })).toContain('(deny network*)');
    expect(buildMacSandboxProfile({ ...policy, network: 'loopback' })).toContain('(remote ip "localhost:*")');
  });

  it('generates Linux readonly binds and preserves the caller process group', () => {
    const root = project();
    const policy = createSandboxPolicy(root);
    const args = buildBubblewrapArgs(policy);
    expect(args.slice(0, 5)).toEqual(['--die-with-parent', '--ro-bind', '/', '/', '--proc']);
    expect(args).toContain('--bind');
    expect(args).toContain(root);
    expect(args).not.toContain('--new-session');
    expect(args).not.toContain('--unshare-net');
    expect(buildBubblewrapArgs({ ...policy, network: 'deny' })).toContain('--unshare-net');
    expect(buildBubblewrapArgs({ ...policy, network: 'loopback' })).toContain('--unshare-net');
  });

  it('reports actual probe availability and uses a deterministic profile hash when available', () => {
    const root = project();
    const policy = createSandboxPolicy(root);
    const status = getSandboxStatus();
    const wrapped = wrapCommand('/bin/sh', ['-c', 'true'], policy, { PWD: root });
    expect(wrapped.sandbox.enabled).toBe(status.enabled);
    expect(wrapped.env.AMD_SANDBOX).toBe(status.enabled ? '1' : '0');
    if (status.enabled) {
      expect(wrapped.sandbox.profileHash).toMatch(/^[a-f0-9]{64}$/);
      expect(wrapCommand('/bin/sh', ['-c', 'true'], policy, { PWD: root }).sandbox.profileHash).toBe(wrapped.sandbox.profileHash);
    } else {
      expect(status.reason).toBeTruthy();
      expect(wrapped.command).toBe('/bin/sh');
    }
  });

  it.runIf(process.platform === 'darwin')('loads each macOS network profile using only the harmless true command', () => {
    const root = project();
    if (!getSandboxStatus().enabled) return;
    for (const network of ['allow', 'loopback', 'deny'] as const) {
      const wrapped = wrapCommand('/usr/bin/true', [], createSandboxPolicy(root, { version: 1, network, writableRoots: [] }), process.env);
      const result = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8', cwd: root, env: wrapped.env });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }
  });

  it('formats synthetic error text without attributing errors to an unavailable sandbox', () => {
    expect(sandboxFailureNotice('Permission denied', { enabled: true, network: 'allow' })).toContain('避免重复执行');
    expect(sandboxFailureNotice('Permission denied', { enabled: false, network: 'allow' })).toBeUndefined();
    expect(sandboxFailureNotice('ordinary build failure', { enabled: true, network: 'allow' })).toBeUndefined();
  });
});

describe('sandbox settings', () => {
  it('validates, atomically stores and reloads network policy and extra directories', () => {
    const root = project();
    const file = path.join(root, 'config', 'sandbox-settings.json');
    const settings = saveSandboxSettings(file, { version: 1, network: 'loopback', writableRoots: [root, root] });
    expect(settings.writableRoots).toEqual([root]);
    expect(loadSandboxSettings(file)).toEqual(settings);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['sandbox-settings.json']);
    expect(loadSandboxSettings(path.join(root, 'missing.json'))).toEqual(DEFAULT_SANDBOX_SETTINGS);
    fs.writeFileSync(file, '{invalid JSON');
    expect(loadSandboxSettings(file)).toEqual(DEFAULT_SANDBOX_SETTINGS);
  });

  it('reports malformed configuration fields', () => {
    expect(() => validateSandboxSettings({ version: 2, network: 'allow', writableRoots: [] })).toThrow('版本');
    expect(() => validateSandboxSettings({ version: 1, network: 'other', writableRoots: [] })).toThrow('网络策略');
    expect(() => validateSandboxSettings({ version: 1, network: 'allow', writableRoots: ['relative-directory'] })).toThrow('绝对路径');
    expect(() => validateSandboxSettings({ version: 1, network: 'allow', writableRoots: [], extra: true })).toThrow('未知字段');
  });
});

describe('sandboxed ordinary project execution', () => {
  it.each(['executor', 'manager'] as const)('runs ordinary project reads/writes through the %s path with shared policy metadata', async (kind) => {
    const root = project();
    fs.writeFileSync(path.join(root, 'input.txt'), 'ordinary project input');
    const script = path.join(root, 'ordinary.cjs');
    fs.writeFileSync(script, 'const fs = require("node:fs"); const value = fs.readFileSync("input.txt", "utf8"); fs.writeFileSync("output.txt", value.toUpperCase()); console.log(value);');
    const policy = vi.fn((projectRoot: string) => createSandboxPolicy(projectRoot, { version: 1, network: 'allow', writableRoots: [] }));
    const command = quote(process.execPath) + ' ' + quote(script);
    const runner = kind === 'executor' ? new CommandExecutor({ sandboxPolicy: policy }) : new ProjectProcessManager({ sandboxPolicy: policy });
    try {
      const result = await runner.run({ projectRoot: root, command, approved: true });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('ordinary project input');
      expect(fs.readFileSync(path.join(root, 'output.txt'), 'utf8')).toBe('ORDINARY PROJECT INPUT');
      expect(result.sandbox).toMatchObject({ enabled: getSandboxStatus().enabled, network: 'allow' });
      expect(policy).toHaveBeenCalledWith(root);
    } finally { runner.dispose(); }
  });
});
