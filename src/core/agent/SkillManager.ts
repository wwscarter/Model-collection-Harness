import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicRuleWrite } from './RuleFiles';
import { containsSensitiveContent } from '@core/security/sensitiveContent';

interface SkillFile { relative: string; size: number; hash: string }
export interface SkillPreview { name: string; content: string; fileCount: number; totalBytes: number; hash: string }
export interface SkillState { enabled: Record<string, boolean>; diagnostics: string[] }
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_FILE_BYTES;
const MAX_FILES = 128;

function skillName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error('技能目录名须为 1–80 位字母、数字、横线或下划线');
  return value;
}
function stateId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value) || value.includes('..')) throw new Error('技能标识无效');
  return value;
}

/** Imports are reviewed file snapshots, with bounded copies into app-owned skills/. */
export class SkillManager {
  readonly skillsDir: string;
  private readonly statePath: string;
  constructor(agentDir: string) {
    fs.mkdirSync(path.join(agentDir, 'skills'), { recursive: true });
    this.skillsDir = fs.realpathSync(path.join(agentDir, 'skills'));
    this.statePath = path.join(fs.realpathSync(agentDir), 'skills-state.json');
  }
  state(): SkillState {
    try {
      if (fs.statSync(this.statePath).size > 100_000) throw new Error('技能启用状态过大');
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as { version?: unknown; enabled?: unknown };
      if (parsed.version !== 1 || !parsed.enabled || typeof parsed.enabled !== 'object' || Array.isArray(parsed.enabled)) throw new Error('技能启用状态无效');
      const enabled: Record<string, boolean> = {};
      for (const [name, value] of Object.entries(parsed.enabled)) { stateId(name); if (typeof value !== 'boolean') throw new Error('技能启用状态无效'); enabled[name] = value; }
      return { enabled, diagnostics: [] };
    } catch (error) { return { enabled: {}, diagnostics: (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : ['技能启用状态无法读取，已暂停加载技能；请修复 skills-state.json 后刷新'] }; }
  }
  isEnabled(filePath: string): boolean {
    let relative: string;
    try { relative = path.relative(this.skillsDir, fs.realpathSync(filePath)); } catch { return false; }
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
    const state = this.state();
    return !state.diagnostics.length && state.enabled[relative.split(path.sep)[0]] !== false;
  }
  setEnabled(name: unknown, enabled: unknown): SkillState {
    const id = stateId(name);
    if (typeof enabled !== 'boolean') throw new Error('技能启用状态无效');
    const stat = fs.lstatSync(path.join(this.skillsDir, id));
    if ((!stat.isDirectory() && !(stat.isFile() && id.endsWith('.md'))) || stat.isSymbolicLink()) throw new Error('技能目录不可用');
    const current = this.state();
    if (current.diagnostics.length) throw new Error(current.diagnostics[0]);
    const next = { ...current.enabled, [id]: enabled };
    atomicRuleWrite(this.statePath, JSON.stringify({ version: 1, enabled: next }, null, 2) + String.fromCharCode(10));
    return { enabled: next, diagnostics: [] };
  }
  async preview(sourceRoot: string): Promise<SkillPreview> {
    return (await this.snapshot(sourceRoot)).preview;
  }
  async import(sourceRoot: string, expectedHash: string): Promise<SkillPreview> {
    const snapshot = await this.snapshot(sourceRoot);
    if (snapshot.preview.hash !== expectedHash) throw new Error('技能目录已变化，请重新预览后导入');
    const target = path.join(this.skillsDir, snapshot.preview.name);
    if (fs.existsSync(target)) throw new Error('同名技能已存在，请先改名再导入');
    const temporary = path.join(this.skillsDir, '.import-' + randomUUID());
    fs.mkdirSync(temporary);
    try {
      for (const file of snapshot.files) {
        const data = await this.readFile(path.join(snapshot.root, file.relative));
        if (data.length !== file.size || createHash('sha256').update(data).digest('hex') !== file.hash) throw new Error('技能文件已变化，请重新预览后导入');
        const destination = path.join(temporary, file.relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, data, { flag: 'wx', mode: 0o600 });
      }
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    return snapshot.preview;
  }
  private async snapshot(sourceRoot: string): Promise<{ root: string; files: SkillFile[]; preview: SkillPreview }> {
    if (!path.isAbsolute(sourceRoot)) throw new Error('技能导入需由文件夹选择器指定绝对路径');
    const stat = await fs.promises.lstat(sourceRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('技能来源必须为普通目录，不能使用符号链接');
    const root = await fs.promises.realpath(sourceRoot);
    const name = skillName(path.basename(root));
    const files: SkillFile[] = [];
    let totalBytes = 0;
    let skillContent: string | undefined;
    const walk = async (relative: string, depth: number) => {
      if (depth > 12) throw new Error('技能目录层级超过 12 层');
      for (const entry of (await fs.promises.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '.git' || entry.name === 'node_modules') throw new Error('技能导入不支持 .git 或 node_modules 目录');
        const child = path.join(relative, entry.name);
        if (entry.isSymbolicLink()) throw new Error('技能导入不支持符号链接');
        if (entry.isDirectory()) await walk(child, depth + 1);
        else if (entry.isFile()) {
          if (files.length >= MAX_FILES) throw new Error('技能文件数量超过 128');
          const content = await this.readFile(path.join(root, child));
          if (child === 'SKILL.md') {
            if (content.includes(0)) throw new Error('SKILL.md 必须为文本');
            skillContent = content.toString('utf8');
          }
          totalBytes += content.length;
          if (totalBytes > MAX_TOTAL_BYTES) throw new Error('技能文件总量超过 8MB');
          files.push({ relative: child, size: content.length, hash: createHash('sha256').update(content).digest('hex') });
        } else throw new Error('技能导入只支持普通文件和目录');
      }
    };
    await walk('', 0);
    if (!skillContent?.trim()) throw new Error('技能目录缺少 SKILL.md');
    if (containsSensitiveContent(skillContent)) throw new Error('技能说明可能包含密钥或令牌');
    return { root, files, preview: { name, content: skillContent, fileCount: files.length, totalBytes, hash: createHash('sha256').update(JSON.stringify(files)).digest('hex') } };
  }
  private async readFile(file: string): Promise<Buffer> {
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('技能只支持不超过 1MB 的普通文件');
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      if (offset > stat.size) throw new Error('技能文件读取期间发生变化');
      return buffer.subarray(0, offset);
    } finally { await handle.close(); }
  }
}
