import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SandboxNetwork } from './Sandbox';

export interface SandboxSettings {
  version: 1;
  network: SandboxNetwork;
  writableRoots: string[];
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = { version: 1, network: 'allow', writableRoots: [] };

export function validateSandboxSettings(input: unknown): SandboxSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('命令沙箱配置必须是对象');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['version', 'network', 'writableRoots'].includes(key))) throw new Error('命令沙箱配置包含未知字段');
  if (value.version !== 1) throw new Error('不支持的命令沙箱配置版本');
  if (typeof value.network !== 'string' || !['allow', 'deny', 'loopback'].includes(value.network)) throw new Error('网络策略须为 allow、loopback 或 deny');
  if (!Array.isArray(value.writableRoots) || value.writableRoots.length > 32) throw new Error('额外可写目录须为最多 32 个目录的列表');
  const roots = value.writableRoots.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 4096 || /[\u0000-\u001f\u007f]/.test(entry)) throw new Error('额外可写目录路径无效');
    const expanded = entry.trim() === '~' ? os.homedir() : entry.trim().startsWith('~/') ? path.join(os.homedir(), entry.trim().slice(2)) : entry.trim();
    if (!path.isAbsolute(expanded)) throw new Error('额外可写目录必须是绝对路径');
    const resolved = path.resolve(expanded);
    if (resolved === path.parse(resolved).root) throw new Error('额外可写目录不能是文件系统根目录');
    return resolved;
  });
  return { version: 1, network: value.network as SandboxNetwork, writableRoots: [...new Set(roots)] };
}

export function loadSandboxSettings(filePath: string): SandboxSettings {
  try {
    if (fs.statSync(filePath).size > 32_000) throw new Error('命令沙箱配置文件过大');
    return validateSandboxSettings(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch { return structuredClone(DEFAULT_SANDBOX_SETTINGS); }
}

export function saveSandboxSettings(filePath: string, input: unknown): SandboxSettings {
  const settings = validateSandboxSettings(input);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally { try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve the original write error. */ } }
  return settings;
}
