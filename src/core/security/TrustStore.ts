import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface TrustGrant { projectRoot: string; file: string; sha256: string; grantedAt: string }
export type TrustGrantInput = Omit<TrustGrant, 'grantedAt'>;
const MAX_BYTES = 4 * 1024 * 1024;

function rootPath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 4_096) throw new Error('信任记录的项目目录无效');
  const root = fs.realpathSync(value);
  if (!fs.statSync(root).isDirectory()) throw new Error('信任记录需要项目目录');
  return root;
}
function relativeFile(root: string, value: string): string {
  if (typeof value !== 'string' || !value || value.length > 4_096 || value.includes('\0')) throw new Error('信任记录的文件名无效');
  const relative = (path.isAbsolute(value) ? path.relative(root, value) : value).replaceAll('\\', '/');
  const normalized = path.posix.normalize(relative);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) throw new Error('信任文件必须位于当前项目');
  return normalized;
}
const key = (root: string, file: string) => root + '\0' + file;
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Explicit file-content grants. No project content is trusted merely because it exists. */
export class TrustStore {
  private grants = new Map<string, TrustGrant>();
  readonly diagnostics: string[] = [];

  constructor(private readonly filePath: string) {
    try {
      if (fs.statSync(filePath).size > MAX_BYTES) throw new Error('信任记录超过容量上限');
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && (parsed as { version?: unknown }).version === 1 ? (parsed as { grants?: unknown }).grants : undefined;
      if (!Array.isArray(entries) || entries.length > 10_000) throw new Error('信任记录格式无效');
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const value = entry as Partial<TrustGrant>;
        if (typeof value.projectRoot !== 'string' || !path.isAbsolute(value.projectRoot) || typeof value.file !== 'string' || !validHash(value.sha256) || typeof value.grantedAt !== 'string' || !Number.isFinite(Date.parse(value.grantedAt))) continue;
        const file = relativeFile(value.projectRoot, value.file);
        this.grants.set(key(value.projectRoot, file), { projectRoot: value.projectRoot, file, sha256: value.sha256, grantedAt: value.grantedAt });
      }
    } catch (error) {
      this.grants.clear();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.diagnostics.push('信任记录读取失败，项目文件需重新确认');
    }
  }

  list(projectRoot?: string): TrustGrant[] {
    const root = projectRoot ? rootPath(projectRoot) : undefined;
    return [...this.grants.values()].filter((entry) => !root || entry.projectRoot === root).map((entry) => ({ ...entry })).sort((a, b) => a.projectRoot.localeCompare(b.projectRoot) || a.file.localeCompare(b.file));
  }

  isTrusted(projectRoot: string, file: string, sha256: string): boolean {
    try { const root = rootPath(projectRoot); return validHash(sha256) && this.grants.get(key(root, relativeFile(root, file)))?.sha256 === sha256; }
    catch { return false; }
  }

  grant(input: TrustGrantInput, now = new Date()): TrustGrant {
    const root = rootPath(input.projectRoot);
    const file = relativeFile(root, input.file);
    if (!validHash(input.sha256)) throw new Error('信任记录的内容哈希无效');
    const existing = this.grants.get(key(root, file));
    if (existing?.sha256 === input.sha256) return { ...existing };
    const grant: TrustGrant = { projectRoot: root, file, sha256: input.sha256, grantedAt: now.toISOString() };
    const next = new Map(this.grants); next.set(key(root, file), grant);
    this.persist(next); this.grants = next;
    return { ...grant };
  }

  revoke(projectRoot: string, file: string): boolean {
    const root = rootPath(projectRoot);
    const id = key(root, relativeFile(root, file));
    if (!this.grants.has(id)) return false;
    const next = new Map(this.grants); next.delete(id);
    this.persist(next); this.grants = next;
    return true;
  }

  private persist(next: Map<string, TrustGrant>): void {
    if (next.size > 10_000) throw new Error('信任记录数量已达上限');
    const content = JSON.stringify({ version: 1, grants: [...next.values()] }, null, 2) + '\n';
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('信任记录超过容量上限');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = this.filePath + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
    } finally { try { fs.rmSync(temporary, { force: true }); } catch { /* retain original write error */ } }
  }
}
