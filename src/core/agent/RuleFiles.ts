import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveAllowedPath } from '@core/tools/projectPaths';

export const MAX_RULE_BYTES = 256 * 1024;
export const MAX_RULE_FILES = 64;
export function ruleId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('规则名称无效');
  const id = value.replace(/\.md$/i, '');
  if (/\.md$/i.test(id)) throw new Error('规则名称不能包含重复的 .md 后缀');
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(id) || id.includes('..')) throw new Error('规则名称需为 1–80 位文字、数字、点、横线或下划线');
  return id;
}

/** Caller supplies an app-owned root or the selected project, never a renderer root. */
export function regularRulePath(root: string, relative: string): string {
  const expected = path.resolve(root, relative);
  const resolved = resolveAllowedPath([root], expected);
  if (resolved !== expected) throw new Error('规则路径必须为普通项目文件');
  return expected;
}

export async function readRuleText(file: string, signal?: AbortSignal): Promise<{ content: string; hash: string } | undefined> {
  signal?.throwIfAborted();
  let handle: fs.promises.FileHandle;
  try { handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('规则文件必须为普通文件');
    if (stat.size > MAX_RULE_BYTES) throw new Error('单条规则不能超过 256KB');
    const buffer = Buffer.alloc(Math.min(MAX_RULE_BYTES + 1, stat.size + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > MAX_RULE_BYTES) throw new Error('单条规则不能超过 256KB');
    if (bytes > stat.size) throw new Error('规则文件读取时已变化，请重试');
    signal?.throwIfAborted();
    const data = buffer.subarray(0, bytes);
    if (data.includes(0)) throw new Error('规则文件必须为文本');
    return { content: data.toString('utf8'), hash: createHash('sha256').update(data).digest('hex') };
  } finally { await handle.close(); }
}

export async function ruleNames(root: string, relativeDirectory: string, signal?: AbortSignal): Promise<{ names: string[]; truncated: boolean }> {
  signal?.throwIfAborted();
  const directory = regularRulePath(root, relativeDirectory);
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { names: [], truncated: false }; throw error; }
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name).sort((a, b) => a.localeCompare(b, 'en'));
  return { names: names.slice(0, MAX_RULE_FILES), truncated: names.length > MAX_RULE_FILES };
}

export function atomicRuleWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { try { fs.rmSync(temporary, { force: true }); } catch { /* retain original error */ } }
}
