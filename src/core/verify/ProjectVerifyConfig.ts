import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ProjectVerifyConfig, VerifyCommand } from './VerificationTypes';

export type { ProjectVerifyConfig } from './VerificationTypes';
export type ProjectVerifyDraft = Omit<ProjectVerifyConfig, 'manifestFingerprint' | 'confirmedAt'>;
export const DEFAULT_VERIFY_OPTIONS = { mode: 'quick' as const, timeoutMs: 120_000, maxRepairRounds: 2 };
export function defaultVerifyConfig(commands: VerifyCommand[] = []): ProjectVerifyDraft {
  return { version: 1, ...DEFAULT_VERIFY_OPTIONS, commands: structuredClone(commands) };
}

export function validateProjectVerifyDraft(input: unknown): ProjectVerifyDraft {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('项目验证配置必须是对象');
  const value = input as Partial<ProjectVerifyConfig>;
  if (value.version !== 1 || !['off', 'quick', 'full'].includes(String(value.mode))) throw new Error('项目验证模式无效');
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs! < 1_000 || value.timeoutMs! > 120_000) throw new Error('验证超时须为 1000–120000 毫秒');
  if (!Number.isSafeInteger(value.maxRepairRounds) || value.maxRepairRounds! < 0 || value.maxRepairRounds! > 3) throw new Error('验证修复轮数须为 0–3');
  if (!Array.isArray(value.commands) || value.commands.length > 16) throw new Error('验证命令最多 16 条');
  const ids = new Set<string>();
  const commands = value.commands.map((entry): VerifyCommand => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(entry.id) || ids.has(entry.id)) throw new Error('验证命令 ID 无效或重复');
    if (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 80 || typeof entry.command !== 'string' || !entry.command.trim() || entry.command.length > 8_192) throw new Error('验证命令标签或内容无效');
    if (entry.phase !== 'quick' && entry.phase !== 'full') throw new Error('验证命令阶段无效');
    ids.add(entry.id);
    return { id: entry.id, label: entry.label.trim(), command: entry.command.trim(), phase: entry.phase };
  });
  return { version: 1, mode: value.mode!, timeoutMs: value.timeoutMs!, maxRepairRounds: value.maxRepairRounds!, commands };
}

export function validateProjectVerifyConfig(input: unknown): ProjectVerifyConfig {
  const draft = validateProjectVerifyDraft(input);
  const value = input as Partial<ProjectVerifyConfig>;
  if (typeof value.manifestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestFingerprint)) throw new Error('验证来源指纹无效');
  if (typeof value.confirmedAt !== 'string' || !Number.isFinite(Date.parse(value.confirmedAt))) throw new Error('验证命令尚未确认');
  return { ...draft, manifestFingerprint: value.manifestFingerprint, confirmedAt: value.confirmedAt };
}

export function projectVerifyConfigPath(dataDir: string, projectRoot: string): string {
  const root = fs.realpathSync(projectRoot);
  const id = createHash('sha1').update(root).digest('hex');
  return path.join(dataDir, 'projects', id, 'verify.json');
}

export function isVerifyConfigCurrent(config: ProjectVerifyConfig | undefined, fingerprint: string): boolean {
  return Boolean(config?.confirmedAt && config.manifestFingerprint === fingerprint);
}

export function loadProjectVerifyConfig(dataDir: string, projectRoot: string, fingerprint?: string): ProjectVerifyConfig | undefined {
  try {
    const file = projectVerifyConfigPath(dataDir, projectRoot);
    if (fs.statSync(file).size > 1024 * 1024) return undefined;
    const config = validateProjectVerifyConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    return fingerprint && !isVerifyConfigCurrent(config, fingerprint) ? undefined : config;
  } catch { return undefined; }
}

export function saveProjectVerifyConfig(dataDir: string, projectRoot: string, input: unknown): ProjectVerifyConfig {
  const config = validateProjectVerifyConfig(input);
  const file = projectVerifyConfigPath(dataDir, projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { try { fs.rmSync(temporary, { force: true }); } catch { /* retain original failure */ } }
  return config;
}

export function confirmProjectVerifyConfig(dataDir: string, projectRoot: string, input: unknown, fingerprint: string, now = new Date()): ProjectVerifyConfig {
  return saveProjectVerifyConfig(dataDir, projectRoot, { ...validateProjectVerifyDraft(input), manifestFingerprint: fingerprint, confirmedAt: now.toISOString() });
}
