import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SANDBOX_SETTINGS, validateSandboxSettings, type SandboxSettings } from './SandboxSettings';

export type SandboxNetwork = 'allow' | 'deny' | 'loopback';
export interface SandboxPolicy { projectRoot: string; writableRoots: string[]; network: SandboxNetwork; }
export interface SandboxMetadata { enabled: boolean; profileHash?: string; network: SandboxNetwork; reason?: string; }
export interface SandboxStatus { enabled: boolean; platform: string; reason?: string; }
export interface SandboxedSpawn { command: string; args: string[]; env: NodeJS.ProcessEnv; sandbox: SandboxMetadata; }
export type SandboxPolicyResolver = (projectRoot: string) => SandboxPolicy;

interface Backend { status: SandboxStatus; executable?: string; }
let cached: { platform: string; path: string | undefined; checkedAt: number; backend: Backend } | undefined;
const HASH = (value: string): string => createHash('sha256').update(value).digest('hex');

function canonical(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('沙箱目录须为有效的绝对路径');
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function protectedRoots(): string[] {
  const roots = ['.ssh', '.aws', 'Library/Keychains'].map((value) => path.join(os.homedir(), value));
  return [...new Set(roots.flatMap((root) => [root, canonical(root)]))];
}

export function createSandboxPolicy(projectRoot: string, settings: SandboxSettings = DEFAULT_SANDBOX_SETTINGS): SandboxPolicy {
  const config = validateSandboxSettings(settings);
  const home = os.homedir();
  const caches = ['.npm', '.cache', '.cargo/registry', '.cargo/git', '.rustup', '.gradle/caches', '.m2/repository', 'go/pkg/mod', 'Library/Caches', 'Library/pnpm/store'].map((value) => path.join(home, value));
  const temporary = process.platform === 'win32' ? [os.tmpdir()] : [os.tmpdir(), '/tmp', '/var/tmp'];
  return { projectRoot: canonical(projectRoot), network: config.network, writableRoots: [...new Set([projectRoot, ...temporary, ...caches, ...config.writableRoots].map(canonical))] };
}

function writableRoots(policy: SandboxPolicy): string[] {
  if (!['allow', 'deny', 'loopback'].includes(policy.network)) throw new Error('沙箱网络策略无效');
  const roots = [...new Set([policy.projectRoot, ...policy.writableRoots].map(canonical))];
  if (roots.some((root) => root === path.parse(root).root)) throw new Error('沙箱不能将整个文件系统设为可写');
  return roots;
}

/** Generate SBPL separately from spawning so it can be inspected without executing commands. */
export function buildMacSandboxProfile(policy: SandboxPolicy): string {
  const roots = writableRoots(policy);
  const rules = ['(version 1)', '(allow default)', '(deny file-write*)', '(allow file-write* ' + roots.map((root) => '(subpath ' + JSON.stringify(root) + ')').join(' ') + ')'];
  // Ordinary child_process stdio:'ignore' opens /dev/null for writing.
  rules.push('(allow file-write* (literal "/dev/null"))');
  const protectedPaths = protectedRoots().map((root) => '(subpath ' + JSON.stringify(root) + ')').join(' ');
  rules.push('(deny file-read* ' + protectedPaths + ')', '(deny file-write* ' + protectedPaths + ')');
  if (policy.network !== 'allow') rules.push('(deny network*)');
  if (policy.network === 'loopback') rules.push('(allow network-outbound (remote ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))', '(allow network-bind (local ip "localhost:*"))');
  return rules.join('\n');
}

/** bubblewrap shares the host process group so cancellation still reaches descendants. */
export function buildBubblewrapArgs(policy: SandboxPolicy, cwd = policy.projectRoot): string[] {
  const args = ['--die-with-parent', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev'];
  if (policy.network !== 'allow') args.push('--unshare-net');
  for (const root of writableRoots(policy)) {
    // A bind source must already exist. Unavailable cache directories stay read-only.
    try { if (fs.statSync(root).isDirectory()) args.push('--bind', root, root); } catch { /* Missing optional cache. */ }
  }
  for (const root of [...new Set(protectedRoots().map(canonical))]) {
    try { args.push(...(fs.statSync(root).isDirectory() ? ['--tmpfs', root] : ['--ro-bind', '/dev/null', root])); } catch { /* No secret directory to mask. */ }
  }
  args.push('--chdir', canonical(cwd));
  return args;
}

function executable(filePath: string): boolean {
  try { fs.accessSync(filePath, fs.constants.X_OK); return fs.statSync(filePath).isFile(); } catch { return false; }
}

function probe(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 2_000, maxBuffer: 16_000, windowsHide: true, env: { PATH: process.env.PATH, HOME: os.homedir(), LANG: process.env.LANG } });
  if (!result.error && result.status === 0) return undefined;
  return (result.error?.message || result.stderr?.trim() || '无害探测命令退出码 ' + result.status).slice(0, 400);
}

function backend(): Backend {
  if (cached && cached.platform === process.platform && cached.path === process.env.PATH && Date.now() - cached.checkedAt < 60_000) return cached.backend;
  let result: Backend;
  if (process.platform === 'darwin') {
    const command = '/usr/bin/sandbox-exec';
    const failure = executable(command) ? probe(command, ['-p', '(version 1)(allow default)', '/usr/bin/true']) : '系统没有 sandbox-exec';
    result = { status: { enabled: !failure, platform: process.platform, ...(failure ? { reason: 'macOS 沙箱不可用：' + failure } : {}) }, ...(failure ? {} : { executable: command }) };
  } else if (process.platform === 'linux') {
    const command = [...new Set(['/usr/bin/bwrap', '/bin/bwrap', ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, 'bwrap'))])].find(executable);
    const failure = command ? probe(command, ['--die-with-parent', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true']) : '未安装 bubblewrap（bwrap）';
    result = { status: { enabled: !failure, platform: process.platform, ...(failure ? { reason: 'Linux 沙箱不可用：' + failure } : {}) }, ...(failure ? {} : { executable: command }) };
  } else result = { status: { enabled: false, platform: process.platform, reason: process.platform === 'win32' ? 'Windows 暂未提供 OS 命令沙箱' : '当前系统暂未提供 OS 命令沙箱' } };
  cached = { platform: process.platform, path: process.env.PATH, checkedAt: Date.now(), backend: result };
  return result;
}

export function getSandboxStatus(): SandboxStatus { return { ...backend().status }; }

export function wrapCommand(shell: string, args: string[], policy: SandboxPolicy, env: NodeJS.ProcessEnv): SandboxedSpawn {
  const runtime = backend();
  const sandbox: SandboxMetadata = { enabled: runtime.status.enabled, network: policy.network, ...(runtime.status.reason ? { reason: runtime.status.reason } : {}) };
  const environment = { ...env, AMD_SANDBOX: sandbox.enabled ? '1' : '0' };
  if (!runtime.status.enabled || !runtime.executable) return { command: shell, args: [...args], env: environment, sandbox };
  if (runtime.status.platform === 'darwin') {
    const profile = buildMacSandboxProfile(policy);
    sandbox.profileHash = HASH(profile);
    return { command: runtime.executable, args: ['-p', profile, shell, ...args], env: environment, sandbox };
  }
  const prefix = buildBubblewrapArgs(policy, env.PWD || policy.projectRoot);
  sandbox.profileHash = HASH(JSON.stringify(prefix));
  if (policy.network === 'loopback') sandbox.reason = 'Linux loopback 使用独立网络空间，无法连接宿主机的本地服务';
  return { command: runtime.executable, args: [...prefix, '--', shell, ...args], env: environment, sandbox };
}

export function sandboxFailureNotice(stderr: string, sandbox: SandboxMetadata): string | undefined {
  if (!sandbox.enabled || !/(operation not permitted|permission denied|read-only file system|network is unreachable)/i.test(stderr)) return undefined;
  return '命令可能受到沙箱文件或网络策略限制；请先检查获准目录与网络设置，避免重复执行同一命令。';
}
