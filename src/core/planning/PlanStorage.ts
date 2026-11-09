import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { RunPlan } from './PlanTypes';

/** Plan versions share the sessions database without coupling message normalization to plans. */
export class PlanStorage {
  private readonly db: Database.Database;
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS plans (run_id TEXT NOT NULL, version INTEGER NOT NULL, session_id TEXT NOT NULL, json TEXT NOT NULL, approved_at TEXT, PRIMARY KEY(run_id, version)); CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id);');
  }
  save(plan: RunPlan): RunPlan {
    this.db.prepare('INSERT INTO plans(run_id,version,session_id,json,approved_at) VALUES(?,?,?,?,?) ON CONFLICT(run_id,version) DO UPDATE SET json=excluded.json,approved_at=excluded.approved_at').run(plan.runId, plan.version, plan.sessionId, JSON.stringify(plan), plan.approvedAt ?? null);
    return structuredClone(plan);
  }
  latest(runId: string): RunPlan | undefined {
    const row = this.db.prepare('SELECT json FROM plans WHERE run_id=? ORDER BY version DESC LIMIT 1').get(runId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as RunPlan : undefined;
  }
  list(sessionId: string): RunPlan[] {
    const rows = this.db.prepare('SELECT p.json FROM plans p JOIN (SELECT run_id,MAX(version) version FROM plans WHERE session_id=? GROUP BY run_id) latest ON latest.run_id=p.run_id AND latest.version=p.version ORDER BY p.rowid').all(sessionId) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as RunPlan);
  }
  versions(runId: string): RunPlan[] {
    return (this.db.prepare('SELECT json FROM plans WHERE run_id=? ORDER BY version').all(runId) as { json: string }[]).map((row) => JSON.parse(row.json) as RunPlan);
  }
  deleteSession(sessionId: string): void { this.db.prepare('DELETE FROM plans WHERE session_id=?').run(sessionId); }
  close(): void { if (this.db.open) this.db.close(); }
}
