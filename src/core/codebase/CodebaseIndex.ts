import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSensitiveRelativePath } from '../security/sensitiveFiles';
import { awaitWithSignal } from '../tools/awaitWithSignal';
import { languageForPath, type CodeSymbol, type IndexedFile, type IndexStats } from './CodebaseTypes';
import { IndexDatabase } from './IndexDatabase';
import { IndexWorkerClient } from './IndexWorkerClient';
import { collectProjectFiles } from './ProjectFiles';

export type { CodeSymbol, IndexStats } from './CodebaseTypes';

/** A local SQLite index per canonical project root; parsing stays off the UI thread. */
export class CodebaseIndex {
  private databases = new Map<string, IndexDatabase>();
  private queues = new Map<string, Promise<unknown>>();
  private worker = new IndexWorkerClient();
  private disposed = false;

  constructor(private dataDir: string) {}

  private project(projectRoot: string): { root: string; database: IndexDatabase } {
    if (this.disposed) throw new Error('Codebase index is disposed');
    const root = fs.realpathSync(path.resolve(projectRoot));
    if (!fs.statSync(root).isDirectory()) throw new Error('Symbol indexing requires a project directory');
    let database = this.databases.get(root);
    if (!database) {
      const directory = path.join(this.dataDir, 'index');
      fs.mkdirSync(directory, { recursive: true });
      database = new IndexDatabase(path.join(directory, createHash('sha1').update(root).digest('hex') + '.db'));
      this.databases.set(root, database);
    }
    return { root, database };
  }

  async refresh(projectRoot: string, paths?: string[], signal?: AbortSignal): Promise<IndexStats> {
    signal?.throwIfAborted();
    const { root, database } = this.project(projectRoot);
    const previous = this.queues.get(root) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.refreshProject(root, database, paths, signal));
    this.queues.set(root, work);
    const cleanup = () => { if (this.queues.get(root) === work) this.queues.delete(root); };
    void work.then(cleanup, cleanup);
    return await awaitWithSignal(work, signal);
  }

  private async refreshProject(root: string, database: IndexDatabase, paths?: string[], signal?: AbortSignal): Promise<IndexStats> {
    if (this.disposed) throw new Error('Codebase index is disposed');
    signal?.throwIfAborted();
    const started = performance.now();
    const scope = paths?.length ? paths.map((value) => {
      const relative = path.relative(root, path.resolve(root, value));
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Index refresh paths must belong to the project');
      return relative.split(path.sep).join('/');
    }) : undefined;
    const inScope = (value: string) => !scope || scope.some((prefix) => !prefix || value === prefix || value.startsWith(prefix + '/'));
    const snapshot = await collectProjectFiles(root, { signal, maxFiles: 50_000, maxFileBytes: 2 * 1024 * 1024 });
    signal?.throwIfAborted();
    if (this.disposed) throw new Error('Codebase index is disposed');
    const candidates = snapshot.files.filter((file) => languageForPath(file.path) && !isSensitiveRelativePath(file.path) && inScope(file.path));
    const stored = database.files();
    const current = new Set(candidates.map((file) => file.path));
    const removed = [...stored.keys()].filter((filePath) => inScope(filePath) && !current.has(filePath));
    database.remove(removed);
    const changed = candidates.filter((file) => {
      const known = stored.get(file.path);
      return !known || known.mtime !== file.mtimeMs || known.size !== file.size;
    });
    const stats: IndexStats = { projectRoot: root, files: candidates.length, indexed: 0, unchanged: candidates.length - changed.length, removed: removed.length, symbols: 0, durationMs: 0, truncated: snapshot.truncated, errors: [] };
    for (let offset = 0; offset < changed.length; offset += 100) {
      signal?.throwIfAborted();
      const extracted = await this.worker.extract(changed.slice(offset, offset + 100), signal);
      const valid = extracted.filter((file) => !file.error);
      if (this.disposed) throw new Error('Codebase index is disposed');
      let batch: IndexedFile[] = [];
      let symbolCount = 0;
      for (const file of valid) {
        if (batch.length && symbolCount + file.symbols.length > 2_000) {
          database.apply(batch);
          await new Promise<void>((resolve) => setImmediate(resolve));
          signal?.throwIfAborted();
          if (this.disposed) throw new Error('Codebase index is disposed');
          batch = [];
          symbolCount = 0;
        }
        batch.push(file);
        symbolCount += file.symbols.length;
      }
      database.apply(batch);
      const failed = extracted.filter((file) => file.error);
      database.remove(failed.map((file) => file.path));
      stats.indexed += valid.length;
      stats.truncated ||= valid.some((file) => file.truncated);
      for (const file of failed) if (stats.errors.length < 100) stats.errors.push(file.path + ': ' + file.error);
    }
    stats.symbols = database.count();
    stats.durationMs = Math.round(performance.now() - started);
    return stats;
  }

  async symbols(projectRoot: string, query: string, kind?: string, limit?: number): Promise<CodeSymbol[]> {
    const { database } = this.project(projectRoot);
    return database.symbols(query, kind, limit).filter((symbol) => !isSensitiveRelativePath(symbol.path));
  }

  dispose(): void {
    this.disposed = true;
    this.worker.dispose();
    for (const database of this.databases.values()) database.close();
    this.databases.clear();
  }
}
