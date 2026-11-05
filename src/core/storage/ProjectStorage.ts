import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** A recently opened project folder. Only the path and a display name are stored, never file contents. */
export interface ProjectRecord {
  id: string;
  name: string;
  /** Resolved (realpath) project root; unique per record. */
  root: string;
  lastOpenedAt: Date;
  createdAt: Date;
}

interface ProjectRow { id: string; name: string; root: string; last_opened_at: string; created_at: string; }

export class ProjectStorage {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspace_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, last_opened_at TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_workspace_projects_opened ON workspace_projects(last_opened_at DESC);`);
  }

  list(): ProjectRecord[] {
    return (this.db.prepare('SELECT * FROM workspace_projects ORDER BY created_at ASC, rowid ASC').all() as ProjectRow[]).map(fromRow);
  }

  get(id: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workspace_projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  getByRoot(root: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workspace_projects WHERE root = ?').get(root) as ProjectRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Inserts or refreshes a project keyed by its resolved root. The stored name only changes when `name` is given. */
  recordOpened(root: string, name?: string, now = new Date()): ProjectRecord {
    const iso = now.toISOString();
    this.db.prepare(`INSERT INTO workspace_projects (id, name, root, last_opened_at, created_at) VALUES (@id, @name, @root, @now, @now)
      ON CONFLICT(root) DO UPDATE SET last_opened_at = excluded.last_opened_at, name = CASE WHEN @rename = 1 THEN excluded.name ELSE workspace_projects.name END`)
      .run({ id: randomUUID(), name: name || path.basename(root) || root, root, now: iso, rename: name ? 1 : 0 });
    return this.getByRoot(root)!;
  }

  /** Removes the record only; the folder on disk is untouched. */
  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM workspace_projects WHERE id = ?').run(id).changes > 0;
  }

  close(): void { if (this.db.open) this.db.close(); }
}

function fromRow(row: ProjectRow): ProjectRecord {
  return { id: row.id, name: row.name, root: row.root, lastOpenedAt: new Date(row.last_opened_at), createdAt: new Date(row.created_at) };
}
