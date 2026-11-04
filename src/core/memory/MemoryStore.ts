import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type MemoryScope = 'global' | 'project' | 'session';
export type MemoryKind = 'preference' | 'fact' | 'decision' | 'todo' | 'artifact';
export type MemoryStatus = 'active' | 'pending';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  projectRoot?: string;
  sessionId?: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  source: 'user' | 'agent' | 'tool';
  confidence: number;
  status: MemoryStatus;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
}

export interface MemoryInput {
  scope?: MemoryScope;
  projectRoot?: string;
  sessionId?: string;
  kind?: MemoryKind;
  content: string;
  tags?: string[];
  source?: 'user' | 'agent' | 'tool';
  confidence?: number;
  status?: MemoryStatus;
  expiresAt?: Date;
}

export interface MemoryFilter {
  scopes?: MemoryScope[];
  projectRoot?: string;
  sessionId?: string;
  kind?: MemoryKind;
  status?: MemoryStatus | 'all';
  limit?: number;
}

interface MemoryRow {
  id: string; scope: string; project_root: string | null; session_id: string | null;
  kind: string; content: string; tags: string; source: string; confidence: number; status: string;
  created_at: string; updated_at: string; last_used_at: string | null; expires_at: string | null;
}

const MAX_CONTENT_CHARS = 2_000;
const SENSITIVE_CONTENT = /(sk-[a-z0-9_-]{16,}|api[_-]?key\s*[:=]|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[a-z0-9]{20,}|xox[baprs]-)/i;

export class MemoryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('busy_timeout = 3000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        project_root TEXT,
        session_id TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, project_root);
      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
      CREATE TABLE IF NOT EXISTS memory_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content='memories', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
    `);
    const columns = this.db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'status')) this.db.exec("ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    try { this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')"); } catch { /* FTS rebuild is best effort */ }
  }

  add(input: MemoryInput): MemoryRecord {
    const content = input.content?.trim();
    if (!content) throw new Error('记忆内容不能为空');
    if (content.length > MAX_CONTENT_CHARS) throw new Error(`记忆内容不能超过 ${MAX_CONTENT_CHARS} 字`);
    if (SENSITIVE_CONTENT.test(content)) throw new Error('记忆内容可能包含密钥或令牌，已拒绝保存');
    const scope = input.scope ?? (input.projectRoot ? 'project' : 'global');
    if (scope === 'project' && !input.projectRoot) throw new Error('项目记忆需要项目目录');
    if (scope === 'session' && !input.sessionId) throw new Error('会话记忆需要会话 ID');
    const now = new Date();
    const record: MemoryRecord = {
      id: randomUUID(),
      scope,
      projectRoot: input.projectRoot,
      sessionId: input.sessionId,
      kind: input.kind ?? 'fact',
      content,
      tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 12))],
      source: input.source ?? 'user',
      confidence: Number.isFinite(input.confidence) ? Math.min(1, Math.max(0, input.confidence!)) : 0.8,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
    };
    this.db.prepare(
      `INSERT INTO memories (id, scope, project_root, session_id, kind, content, tags, source, confidence, status, created_at, updated_at, last_used_at, expires_at)
       VALUES (@id, @scope, @project_root, @session_id, @kind, @content, @tags, @source, @confidence, @status, @created_at, @updated_at, @last_used_at, @expires_at)`,
    ).run({
      id: record.id, scope: record.scope, project_root: record.projectRoot ?? null, session_id: record.sessionId ?? null,
      kind: record.kind, content: record.content, tags: JSON.stringify(record.tags), source: record.source,
      confidence: record.confidence, status: record.status, created_at: record.createdAt.toISOString(), updated_at: record.updatedAt.toISOString(),
      last_used_at: null, expires_at: record.expiresAt?.toISOString() ?? null,
    });
    return record;
  }

  list(filter: MemoryFilter = {}): MemoryRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.scopes?.length) { clauses.push(`scope IN (${filter.scopes.map(() => '?').join(',')})`); params.push(...filter.scopes); }
    if (filter.projectRoot) { clauses.push('(scope = ? AND project_root = ?)'); params.push('project', filter.projectRoot); }
    if (filter.sessionId) { clauses.push('(scope = ? AND session_id = ?)'); params.push('session', filter.sessionId); }
    if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
    if (filter.status && filter.status !== 'all') { clauses.push('status = ?'); params.push(filter.status); }
    else if (!filter.status) { clauses.push("status = 'active'"); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(2_000, Math.max(1, Math.floor(filter.limit ?? 500)));
    const rows = this.db.prepare(`SELECT * FROM memories${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit) as MemoryRow[];
    return rows.map(toRecord).filter((record) => !record.expiresAt || record.expiresAt.getTime() > Date.now());
  }

  /** FTS5 candidate search; filters are applied after the ranked query. */
  search(query: string, filter: MemoryFilter = {}): MemoryRecord[] {
    const trimmed = query.trim();
    if (!trimmed) return this.list(filter);
    const terms = trimmed.split(/\s+/).filter(Boolean).slice(0, 12).map((term) => `"${term.replace(/"/g, '""')}"`);
    if (!terms.length) return this.list(filter);
    try {
      const rows = this.db.prepare(
        `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? ORDER BY rank LIMIT 200`,
      ).all(terms.join(' OR ')) as MemoryRow[];
      const scopes = new Set(filter.scopes ?? ['global', 'project', 'session']);
      return rows.map(toRecord).filter((record) => {
        if (!scopes.has(record.scope)) return false;
        if (filter.projectRoot && record.scope === 'project' && record.projectRoot !== filter.projectRoot) return false;
        if (filter.projectRoot && record.scope === 'session') return false;
        if (filter.sessionId && record.scope === 'session' && record.sessionId !== filter.sessionId) return false;
        if (filter.kind && record.kind !== filter.kind) return false;
        if (record.status !== 'active') return false;
        return !record.expiresAt || record.expiresAt.getTime() > Date.now();
      }).slice(0, Math.min(200, Math.max(1, filter.limit ?? 50)));
    } catch {
      return this.list(filter).filter((record) => record.content.toLowerCase().includes(trimmed.toLowerCase())).slice(0, Math.min(200, Math.max(1, filter.limit ?? 50)));
    }
  }

  getAutoExtract(): boolean {
    const row = this.db.prepare('SELECT value FROM memory_settings WHERE key = ?').get('auto_extract') as { value: string } | undefined;
    return row?.value === '1';
  }

  setAutoExtract(enabled: boolean): void {
    this.db.prepare('INSERT INTO memory_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('auto_extract', enabled ? '1' : '0');
  }

  approve(id: string): boolean {
    return this.db.prepare("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id).changes > 0;
  }

  exportAll(): MemoryRecord[] { return this.list({ limit: 2_000, status: 'all' }); }

  clear(): number {
    return this.db.transaction(() => this.db.prepare('DELETE FROM memories').run().changes)();
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  touch(ids: string[]): void {
    const now = new Date().toISOString();
    const update = this.db.prepare('UPDATE memories SET last_used_at = ? WHERE id = ?');
    this.db.transaction(() => { for (const id of ids) update.run(now, id); })();
  }

  close(): void { if (this.db.open) this.db.close(); }
}

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id, scope: row.scope as MemoryScope, projectRoot: row.project_root ?? undefined,
    sessionId: row.session_id ?? undefined, kind: row.kind as MemoryKind, content: row.content,
    tags: parseTags(row.tags), source: row.source as MemoryRecord['source'], confidence: row.confidence,
    status: row.status === 'pending' ? 'pending' : 'active',
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
    expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
  };
}

function parseTags(value: string): string[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []; } catch { return []; }
}
