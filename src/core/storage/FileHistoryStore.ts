import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isSensitiveRelativePath, normalizeRelativePath } from '@core/security/sensitiveFiles';
import { isWithin, realOrSelf } from '@core/tools/projectPaths';
import type { FileChangeRecorder, FileChangeTarget } from '@core/tools/fileChanges';

export interface FileChangeRecord {
  runId: string;
  path: string;
  relativePath: string;
  /** false when the agent created the file during this run. */
  existed: boolean;
  /** false when the previous content exceeded the snapshot limit and cannot be restored automatically. */
  beforeAvailable: boolean;
  createdAt: string;
  restoredAt?: string;
}

export interface FileRestoreResult {
  /** Relative paths that were restored (or deleted, for files the run created). */
  restored: string[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface FileChangeCapture {
  runId: string;
  sessionId?: string;
  projectRoot: string;
}

interface ChangeRow {
  run_id: string;
  path: string;
  relative_path: string;
  project_root: string;
  existed: number;
  before: Buffer | null;
  after_hash: string | null;
  created_at: string;
  restored_at: string | null;
}


/** Larger files are listed but not snapshotted: a rollback must never exhaust memory or disk. */
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_CHANGES_PER_RUN = 300;
const RETENTION_DAYS = 30;
/** Keep at most this many runs of snapshots; old runs are pruned at the next run start. */
const MAX_STORED_RUNS = 200;
/** Total snapshot budget; protects the data directory from a run full of large files. */
const MAX_SNAPSHOT_BYTES_TOTAL = 200 * 1024 * 1024;

const hashOf = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/**
 * Records the pre-write state of every file the agent mutates so a run can be
 * rolled back as a unit. Only the first snapshot per file is kept, so restoring
 * returns the file to how it looked before this run started.
 *
 * Restores are deliberately conservative: a file that was modified after the
 * run, a credential path, or a file whose post-write hash was never recorded is
 * skipped instead of overwritten.
 */
export class FileHistoryStore {
  private readonly db: Database.Database;
  private readonly closed = { value: false };

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_changes (
        run_id TEXT NOT NULL,
        path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        project_root TEXT NOT NULL,
        existed INTEGER NOT NULL,
        before BLOB,
        after_hash TEXT,
        created_at TEXT NOT NULL,
        restored_at TEXT,
        PRIMARY KEY (run_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_file_changes_created ON file_changes(created_at DESC);
    `);
    this.prune();
  }

  /** Build a recorder bound to one run; the agent tools call it around each write. */
  recorder(capture: FileChangeCapture): FileChangeRecorder {
    return {
      beforeWrite: async (file) => { try { await this.capture(capture, file); } catch (error) { warn('记录文件修改前状态失败', error); } },
      afterWrite: async ({ path: filePath, content }) => { try { this.complete(capture.runId, filePath, hashOf(content)); } catch (error) { warn('记录文件写入后状态失败', error); } },
    };
  }

  list(runId: string): FileChangeRecord[] {
    const rows = this.db.prepare('SELECT run_id, path, relative_path, existed, before, created_at, restored_at FROM file_changes WHERE run_id = ? ORDER BY created_at, relative_path').all(runId) as ChangeRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      path: row.path,
      relativePath: row.relative_path,
      existed: Boolean(row.existed),
      beforeAvailable: row.existed === 0 || row.before !== null,
      createdAt: row.created_at,
      ...(row.restored_at ? { restoredAt: row.restored_at } : {}),
    }));
  }

  hasChanges(runId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM file_changes WHERE run_id = ? LIMIT 1').get(runId));
  }

  async restore(runId: string): Promise<FileRestoreResult> {
    const rows = this.db.prepare('SELECT * FROM file_changes WHERE run_id = ? AND restored_at IS NULL ORDER BY created_at, relative_path').all(runId) as ChangeRow[];
    const restored: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const row of rows) {
      const target = await this.restoreOne(row);
      if (target.ok) {
        restored.push(row.relative_path);
        this.db.prepare('UPDATE file_changes SET restored_at = ? WHERE run_id = ? AND path = ?').run(new Date().toISOString(), runId, row.path);
      } else {
        skipped.push({ path: row.relative_path, reason: target.reason });
      }
    }
    return { restored, skipped };
  }

  deleteRun(runId: string): void { this.db.prepare('DELETE FROM file_changes WHERE run_id = ?').run(runId); }

  prune(): void {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare('DELETE FROM file_changes WHERE created_at < ?').run(cutoff);
    this.db.prepare(`
      DELETE FROM file_changes WHERE run_id NOT IN (
        SELECT run_id FROM file_changes GROUP BY run_id ORDER BY MAX(created_at) DESC LIMIT ?
      )
    `).run(MAX_STORED_RUNS);
    const bytes = (this.db.prepare('SELECT COALESCE(SUM(LENGTH(before)), 0) AS bytes FROM file_changes').get() as { bytes: number }).bytes;
    if (bytes > MAX_SNAPSHOT_BYTES_TOTAL) {
      this.db.prepare(`
        DELETE FROM file_changes WHERE run_id IN (
          SELECT run_id FROM file_changes GROUP BY run_id ORDER BY MAX(created_at) ASC LIMIT ?
        )
      `).run(Math.max(1, Math.ceil(MAX_STORED_RUNS / 2)));
    }
  }

  close(): void {
    if (this.closed.value) return;
    this.closed.value = true;
    if (this.db.open) this.db.close();
  }

  private async capture(capture: FileChangeCapture, file: FileChangeTarget): Promise<void> {
    if (this.db.prepare('SELECT 1 FROM file_changes WHERE run_id = ? AND path = ?').get(capture.runId, file.path)) return;
    const count = (this.db.prepare('SELECT COUNT(*) AS total FROM file_changes WHERE run_id = ?').get(capture.runId) as { total: number }).total;
    if (count >= MAX_CHANGES_PER_RUN) return;
    // Prune once per run rather than on every write.
    if (count === 0) this.prune();
    let existed = false;
    let before: Buffer | null = null;
    try {
      const stat = await fs.promises.stat(file.path);
      if (stat.isFile()) {
        existed = true;
        if (stat.size <= MAX_SNAPSHOT_BYTES) before = await fs.promises.readFile(file.path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO file_changes (run_id, path, relative_path, project_root, existed, before, after_hash, created_at, restored_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)
    `).run(capture.runId, file.path, file.relativePath, capture.projectRoot, existed ? 1 : 0, before, new Date().toISOString());
  }

  private complete(runId: string, filePath: string, afterHash: string): void {
    this.db.prepare('UPDATE file_changes SET after_hash = ? WHERE run_id = ? AND path = ?').run(afterHash, runId, filePath);
  }

  private async restoreOne(row: ChangeRow): Promise<{ ok: true } | { ok: false; reason: string }> {
    const relativePath = normalizeRelativePath(row.relative_path);
    if (isSensitiveRelativePath(relativePath)) return { ok: false, reason: '凭据或版本库文件不参与自动撤销' };
    let projectRoot: string, target: string;
    try {
      projectRoot = realOrSelf(row.project_root);
      target = realOrSelf(row.path);
    } catch { return { ok: false, reason: '文件路径无法安全解析' }; }
    if (!isWithin(projectRoot, target)) return { ok: false, reason: '文件不在项目目录内' };
    if (row.existed === 1 && row.before === null) return { ok: false, reason: '原文件超过 1 MiB，未保存快照' };

    let current: Buffer | null = null;
    try { current = await fs.promises.readFile(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, reason: '无法读取当前文件' }; }
    if (!row.after_hash) return { ok: false, reason: '缺少写入后校验，未自动撤销' };
    const currentHash = current ? hashOf(current) : undefined;
    if (currentHash && currentHash !== row.after_hash) return { ok: false, reason: '本轮之后文件又被修改' };

    if (row.existed === 0) {
      if (current) await fs.promises.rm(target, { force: true });
      return { ok: true };
    }
    if (!current) return { ok: false, reason: '文件已被删除，未自动恢复' };
    const handle = await fs.promises.open(target, fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0));
    try { await handle.writeFile(row.before!); } finally { await handle.close(); }
    return { ok: true };
  }
}

function warn(message: string, error: unknown): void {
  // Bookkeeping failures must stay visible without interrupting the write.
  console.warn('[file-history] ' + message, error instanceof Error ? error.message : error);
}

