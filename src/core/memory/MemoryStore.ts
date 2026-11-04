import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type MemoryScope = 'global' | 'project' | 'session';
export type MemoryKind = 'preference' | 'fact' | 'decision' | 'todo' | 'artifact';

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
  expiresAt?: Date;
}

export interface MemoryFilter {
  scopes?: MemoryScope[];
  projectRoot?: string;
  sessionId?: string;
  kind?: MemoryKind;
  limit?: number;
}

interface MemoryRow {
  id: string; scope: string; project_root: string | null; session_id: string | null;
  kind: string; content: string; tags: string; source: string; confidence: number;
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, project_root);
      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
    `);
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
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
    };
    this.db.prepare(
      `INSERT INTO memories (id, scope, project_root, session_id, kind, content, tags, source, confidence, created_at, updated_at, last_used_at, expires_at)
       VALUES (@id, @scope, @project_root, @session_id, @kind, @content, @tags, @source, @confidence, @created_at, @updated_at, @last_used_at, @expires_at)`,
    ).run({
      id: record.id, scope: record.scope, project_root: record.projectRoot ?? null, session_id: record.sessionId ?? null,
      kind: record.kind, content: record.content, tags: JSON.stringify(record.tags), source: record.source,
      confidence: record.confidence, created_at: record.createdAt.toISOString(), updated_at: record.updatedAt.toISOString(),
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
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(2_000, Math.max(1, Math.floor(filter.limit ?? 500)));
    const rows = this.db.prepare(`SELECT * FROM memories${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit) as MemoryRow[];
    return rows.map(toRecord).filter((record) => !record.expiresAt || record.expiresAt.getTime() > Date.now());
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
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
    expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
  };
}

function parseTags(value: string): string[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []; } catch { return []; }
}
