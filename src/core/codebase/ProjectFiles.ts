import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import { gitIgnored, type IgnoreScope } from '../project/ProjectIgnore';
import { isSensitiveRelativePath } from '@core/security/sensitiveFiles';

export interface ProjectFile { path: string; absolutePath: string; mtimeMs: number; ctimeMs?: number; size: number }
export interface ProjectFileOptions { signal?: AbortSignal; maxFiles?: number; maxFileBytes?: number; scope?: string }
export interface ProjectFileCollection { files: ProjectFile[]; truncated: boolean }
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const BUILD_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', 'release', 'coverage', '.next', '.nuxt', '.output', '.cache', '.venv', 'venv', '__pycache__', 'target', '.turbo']);
const boundedLimit = (value: number | undefined, fallback: number, max: number): number => Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value!))) : fallback;

function excluded(relative: string, directory: boolean, scopes: IgnoreScope[]): boolean {
  if (isSensitiveRelativePath(relative)) return true;
  if (directory && BUILD_DIRECTORIES.has(path.posix.basename(relative))) return true;
  return gitIgnored(relative, directory, scopes);
}

/** Shared bounded scan for search and indexing. Only ordinary files are returned. */
export async function collectProjectFiles(root: string, options: ProjectFileOptions = {}): Promise<ProjectFileCollection> {
  options.signal?.throwIfAborted();
  const absoluteRoot = await fs.promises.realpath(root);
  if (!(await fs.promises.stat(absoluteRoot)).isDirectory()) throw new Error('项目目录无效');
  const scope = options.scope ? path.relative(absoluteRoot, path.resolve(absoluteRoot, options.scope)).split(path.sep).join('/') : '';
  if (scope === '..' || scope.startsWith('../') || path.isAbsolute(scope)) throw new Error('扫描范围必须位于项目内');
  const maxFiles = boundedLimit(options.maxFiles, 5_000, 1_000_000);
  const maxFileBytes = boundedLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 64 * 1024 * 1024);
  const maxEntries = Math.min(2_000_000, maxFiles * 20 + 1_000);
  const files: ProjectFile[] = [];
  let truncated = false;
  let visited = 0;
  let ignoreBytes = 0;

  async function walk(directory: string, inherited: IgnoreScope[], depth: number): Promise<void> {
    options.signal?.throwIfAborted();
    if (depth > 64) { truncated = true; return; }
    const absoluteDirectory = path.join(absoluteRoot, directory);
    let scopes = inherited;
    try {
      const file = path.join(absoluteDirectory, '.gitignore');
      const stat = await fs.promises.lstat(file);
      if (stat.isFile() && stat.size <= 256_000 && ignoreBytes + stat.size <= 1_000_000) {
        ignoreBytes += stat.size;
        const text = await fs.promises.readFile(file, { encoding: 'utf8', signal: options.signal });
        scopes = [...inherited, { directory, rules: ignore().add(text) }];
      } else if (stat.isFile()) { truncated = true; return; }
    } catch (error) {
      options.signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') { truncated = true; return; }
      if (code !== 'ENOENT') throw error;
    }
    let entries: fs.Dir | Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
    try {
      if (scope && scope !== directory && (!directory || scope.startsWith(directory + '/'))) {
        const name = scope.slice(directory ? directory.length + 1 : 0).split('/')[0];
        const stat = await fs.promises.lstat(path.join(absoluteDirectory, name));
        entries = [{ name, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink() }];
      } else entries = await fs.promises.opendir(absoluteDirectory);
    }
    catch (error) {
      if (['EACCES', 'EPERM', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) { truncated = true; return; }
      throw error;
    }
    for await (const entry of entries) {
      options.signal?.throwIfAborted();
      if (++visited > maxEntries || files.length >= maxFiles) { truncated = true; return; }
      if (entry.isSymbolicLink()) continue;
      const relative = directory ? directory + '/' + entry.name : entry.name;
      if (excluded(relative, entry.isDirectory(), scopes)) continue;
      if (entry.isDirectory()) await walk(relative, scopes, depth + 1);
      else if (entry.isFile()) {
        try {
          const absolutePath = path.join(absoluteRoot, relative);
          const stat = await fs.promises.lstat(absolutePath);
          if (!stat.isFile()) continue;
          if (stat.size > maxFileBytes) { truncated = true; continue; }
          files.push({ path: relative, absolutePath, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size });
        } catch (error) {
          if (!['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          truncated = true;
        }
      }
      if (visited > maxEntries || files.length >= maxFiles) { truncated = true; return; }
    }
  }

  await walk('', [], 0);
  options.signal?.throwIfAborted();
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), truncated };
}
