import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type RunCheckpointStatus = 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled' | 'acknowledged';

export interface RunCheckpoint {
  runId: string;
  sessionId?: string;
  prompt?: string;
  status: RunCheckpointStatus;
  toolCalls: number;
  modifiedFiles: string[];
  lastTool?: string;
  startedAt: string;
  updatedAt: string;
}

interface CheckpointRow {
  run_id: string; session_id: string | null; prompt: string | null; status: RunCheckpointStatus;
  tool_calls: number; modified_files: string; last_tool: string | null; started_at: string; updated_at: string;
}

const RETENTION_DAYS = 30;
const MAX_MODIFIED_FILES = 200;

/**
 * Progress trail for one agent run. It is intentionally shallow: counts, the
 * last tool and the files the run touched. After a crash it lets the next
 * launch say "this task stopped after N steps and changed M files" without
 * replaying tools or pretending the task finished.
 */
export class RunCheckpointStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_checkpoints (
        run_id TEXT PRIMARY KEY,
        session_id TEXT,
        prompt TEXT,
        status TEXT NOT NULL,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        modified_files TEXT NOT NULL DEFAULT '[]',
        last_tool TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_checkpoints_session ON run_checkpoints(session_id, updated_at DESC);
    `);
    // A fresh process owns no running agent; anything still "running" died with the last one.
    this.db.prepare("UPDATE run_checkpoints SET status = 'interrupted', updated_at = ? WHERE status = 'running'").run(new Date().toISOString());
    this.prune();
  }

  start(input: { runId: string; sessionId?: string; prompt?: string }): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO run_checkpoints (run_id, session_id, prompt, status, tool_calls, modified_files, started_at, updated_at)
      VALUES (?, ?, ?, 'running', 0, '[]', ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET status = 'running', session_id = excluded.session_id, prompt = excluded.prompt, started_at = excluded.started_at, updated_at = excluded.updated_at`)
      .run(input.runId, input.sessionId ?? null, input.prompt?.slice(0, 300) ?? null, now, now);
  }

  tool(input: { runId: string; toolName: string; path?: string; failed?: boolean }): void {
    const row = this.db.prepare('SELECT modified_files FROM run_checkpoints WHERE run_id = ?').get(input.runId) as { modified_files: string } | undefined;
    if (!row) return;
    const files = parseFiles(row.modified_files);
    if (!input.failed && input.path && ['write', 'edit'].includes(input.toolName) && !files.includes(input.path) && files.length < MAX_MODIFIED_FILES) files.push(input.path);
    this.db.prepare('UPDATE run_checkpoints SET tool_calls = tool_calls + 1, modified_files = ?, last_tool = ?, updated_at = ? WHERE run_id = ?')
      .run(JSON.stringify(files), input.toolName.slice(0, 120), new Date().toISOString(), input.runId);
  }

  finish(runId: string, status: Exclude<RunCheckpointStatus, 'running' | 'interrupted' | 'acknowledged'>): void {
    this.db.prepare("UPDATE run_checkpoints SET status = ?, updated_at = ? WHERE run_id = ? AND status = 'running'").run(status, new Date().toISOString(), runId);
  }

  latest(sessionId: string): RunCheckpoint | undefined {
    const row = this.db.prepare('SELECT * FROM run_checkpoints WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1').get(sessionId) as CheckpointRow | undefined;
    return row ? toCheckpoint(row) : undefined;
  }

  interrupted(limit = 50): RunCheckpoint[] {
    const rows = this.db.prepare("SELECT * FROM run_checkpoints WHERE status = 'interrupted' ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(200, limit))) as CheckpointRow[];
    return rows.map(toCheckpoint);
  }

  acknowledge(runId: string): void {
    this.db.prepare("UPDATE run_checkpoints SET status = 'acknowledged', updated_at = ? WHERE run_id = ? AND status = 'interrupted'").run(new Date().toISOString(), runId);
  }

  prune(now = new Date()): void {
    this.db.prepare('DELETE FROM run_checkpoints WHERE updated_at < ?').run(new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString());
  }

  close(): void { if (this.db.open) this.db.close(); }
}

function parseFiles(value: string): string[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_MODIFIED_FILES) : []; }
  catch { return []; }
}

function toCheckpoint(row: CheckpointRow): RunCheckpoint {
  return {
    runId: row.run_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.prompt ? { prompt: row.prompt } : {}),
    status: row.status,
    toolCalls: row.tool_calls,
    modifiedFiles: parseFiles(row.modified_files),
    ...(row.last_tool ? { lastTool: row.last_tool } : {}),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}
