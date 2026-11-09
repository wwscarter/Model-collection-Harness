import type Database from 'better-sqlite3';

export interface VerificationMetric {
  runId: string;
  status: 'passed' | 'failed' | 'unverified' | 'skipped' | 'cancelled' | 'budget_limit';
  attempts: number;
  repairRounds: number;
  durationMs: number;
}
export interface VerificationSummary { verificationCount?: number; verificationPassRate?: number; verificationUnverified?: number; }

/** Project checks have a separate denominator from successful model requests. */
export class VerificationMetrics {
  constructor(private readonly db: Database.Database) {
    db.exec('CREATE TABLE IF NOT EXISTS project_verifications (run_id TEXT PRIMARY KEY,status TEXT NOT NULL,attempts INTEGER NOT NULL,repair_rounds INTEGER NOT NULL,duration_ms INTEGER NOT NULL,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS project_verifications_created ON project_verifications(created_at);');
  }
  record(input: VerificationMetric): void {
    this.db.prepare('INSERT INTO project_verifications VALUES(@runId,@status,@attempts,@repairRounds,@durationMs,@createdAt) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,repair_rounds=excluded.repair_rounds,duration_ms=excluded.duration_ms,created_at=excluded.created_at')
      .run({ ...input, createdAt: new Date().toISOString() });
  }
  summary(range: { from?: Date | string; to?: Date | string }): VerificationSummary {
    const clauses: string[] = [];
    const parameters: string[] = [];
    for (const [key, operator] of [['from', '>='], ['to', '<=']] as const) {
      const value = range[key];
      if (value) { clauses.push('created_at ' + operator + ' ?'); parameters.push(new Date(value instanceof Date ? value.getTime() : value).toISOString()); }
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db.prepare('SELECT status,COUNT(*) AS count FROM project_verifications' + where + ' GROUP BY status').all(...parameters) as Array<{ status: string; count: number }>;
    if (!rows.length) return {};
    const count = (status: string) => rows.find((row) => row.status === status)?.count ?? 0;
    const verified = count('passed') + count('failed');
    return { verificationCount: verified, verificationPassRate: verified ? count('passed') / verified : undefined, verificationUnverified: rows.reduce((total, row) => total + row.count, 0) - verified };
  }
}
