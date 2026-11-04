import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { RunTrace, TraceRunRecord, TraceSpanRecord, TraceStore } from '../trace/types';

export type InvocationStatus = 'running' | 'success' | 'failure' | 'timeout';
export interface ModelInvocation { id: string; taskId: string; modelId: string; startTime: Date; endTime?: Date; inputTokens: number; outputTokens: number; totalCost: number; status: InvocationStatus; errorMessage?: string; latency?: number; }
export interface TaskMetrics { taskId: string; totalInvocations: number; modelsUsed: string[]; totalTokens: number; totalCost: number; successRate: number; avgLatency: number; }
export interface MetricsTimeRange { from?: Date | string; to?: Date | string; }
export interface ModelMetrics { modelId: string; invocations: number; successfulInvocations: number; successRate: number; inputTokens: number; outputTokens: number; totalTokens: number; totalCost: number; avgLatency: number; share: number; }
export interface CostTrendPoint { bucket: string; invocations: number; totalTokens: number; totalCost: number; }
export interface AuditMetric { id: string; taskId: string; modelId?: string; approved: boolean; score?: number; createdAt: Date; }
export interface MetricsSummary { totalInvocations: number; totalTasks: number; totalTokens: number; totalCost: number; successRate: number; avgLatency: number; auditCount: number; auditPassRate: number; }
export interface ObservabilityReport { generatedAt: Date; range: { from?: Date; to?: Date }; summary: MetricsSummary; models: ModelMetrics[]; costTrend: CostTrendPoint[]; recent: ModelInvocation[]; }
export interface DashboardSnapshot { generatedAt: Date; range: { from?: Date; to?: Date }; summary: MetricsSummary; modelUsage: ModelMetrics[]; costTrend: CostTrendPoint[]; recent: ModelInvocation[]; }

interface InvocationRow { id: string; task_id: string; model_id: string; start_time: string; end_time: string | null; input_tokens: number; output_tokens: number; total_cost: number; status: InvocationStatus; error_message: string | null; latency: number | null; }
interface AuditRow { id: string; task_id: string; model_id: string | null; approved: number; score: number | null; created_at: string; }
interface TraceRunRow { id: string; session_id: string; task_type: string | null; complexity: string | null; status: string; started_at: string; ended_at: string | null; duration_ms: number | null; total_input_tokens: number; total_output_tokens: number; total_cost: number; error_message: string | null; }
interface TraceSpanRow { id: string; run_id: string; parent_span_id: string | null; kind: string; name: string; status: string; started_at: string; ended_at: string | null; duration_ms: number | null; model_id: string | null; input_tokens: number; output_tokens: number; cost: number; attributes: string | null; error_message: string | null; }

/** SQLite-backed metrics collection and reporting. Writes are atomic and all read APIs accept an optional UTC time range. */
export class ObservabilityEngine implements TraceStore {
  private readonly db: Database.Database;
  private readonly running = new Map<string, ModelInvocation>();

  constructor(dbPath = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invocations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error_message TEXT,
        latency INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_invocations_task ON invocations(task_id);
      CREATE INDEX IF NOT EXISTS idx_invocations_model ON invocations(model_id);
      CREATE INDEX IF NOT EXISTS idx_invocations_start ON invocations(start_time);
      CREATE TABLE IF NOT EXISTS audit_results (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        model_id TEXT,
        approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
        score REAL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_results_created ON audit_results(created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_results_task ON audit_results(task_id);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_type TEXT,
        complexity TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost REAL NOT NULL DEFAULT 0,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS spans (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_span_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER,
        model_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        attributes TEXT,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_spans_run ON spans(run_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  recordInvocationStart(taskId: string, modelId: string): string {
    const id = randomUUID();
    this.running.set(id, { id, taskId, modelId, startTime: new Date(), inputTokens: 0, outputTokens: 0, totalCost: 0, status: 'running' });
    return id;
  }

  recordInvocationEnd(id: string, inputTokens: number, outputTokens: number, rates: { input: number; output: number }, status: Exclude<InvocationStatus, 'running'> = 'success', errorMessage?: string): ModelInvocation | undefined {
    const invocation = this.running.get(id);
    if (!invocation) return undefined;
    const endTime = new Date();
    const completed: ModelInvocation = { ...invocation, endTime, inputTokens, outputTokens, totalCost: (inputTokens * rates.input + outputTokens * rates.output) / 1000, status, errorMessage, latency: Math.max(0, endTime.getTime() - invocation.startTime.getTime()) };
    this.db.prepare('INSERT INTO invocations (id, task_id, model_id, start_time, end_time, input_tokens, output_tokens, total_cost, status, error_message, latency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(completed.id, completed.taskId, completed.modelId, completed.startTime.toISOString(), completed.endTime!.toISOString(), completed.inputTokens, completed.outputTokens, completed.totalCost, completed.status, completed.errorMessage ?? null, completed.latency);
    this.running.delete(id);
    return completed;
  }

  saveTraceRun(run: TraceRunRecord): void {
    this.db.prepare(
      `INSERT INTO runs (id, session_id, task_type, complexity, status, started_at, ended_at, duration_ms, total_input_tokens, total_output_tokens, total_cost, error_message)
       VALUES (@id, @session_id, @task_type, @complexity, @status, @started_at, @ended_at, @duration_ms, @total_input_tokens, @total_output_tokens, @total_cost, @error_message)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id, task_type = excluded.task_type, complexity = excluded.complexity,
         status = excluded.status, started_at = excluded.started_at, ended_at = excluded.ended_at,
         duration_ms = excluded.duration_ms, total_input_tokens = excluded.total_input_tokens,
         total_output_tokens = excluded.total_output_tokens, total_cost = excluded.total_cost,
         error_message = excluded.error_message`,
    ).run({
      id: run.id, session_id: run.sessionId, task_type: run.taskType ?? null, complexity: run.complexity ?? null,
      status: run.status, started_at: run.startedAt, ended_at: run.endedAt ?? null, duration_ms: run.durationMs ?? null,
      total_input_tokens: run.totalInputTokens, total_output_tokens: run.totalOutputTokens, total_cost: run.totalCost,
      error_message: run.errorMessage ?? null,
    });
  }

  saveTraceSpan(span: TraceSpanRecord): void {
    this.db.prepare(
      `INSERT INTO spans (id, run_id, parent_span_id, kind, name, status, started_at, ended_at, duration_ms, model_id, input_tokens, output_tokens, cost, attributes, error_message)
       VALUES (@id, @run_id, @parent_span_id, @kind, @name, @status, @started_at, @ended_at, @duration_ms, @model_id, @input_tokens, @output_tokens, @cost, @attributes, @error_message)
       ON CONFLICT(id) DO UPDATE SET
         parent_span_id = excluded.parent_span_id, kind = excluded.kind, name = excluded.name, status = excluded.status,
         started_at = excluded.started_at, ended_at = excluded.ended_at, duration_ms = excluded.duration_ms,
         model_id = excluded.model_id, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cost = excluded.cost, attributes = excluded.attributes, error_message = excluded.error_message`,
    ).run({
      id: span.id, run_id: span.runId, parent_span_id: span.parentSpanId ?? null, kind: span.kind, name: span.name,
      status: span.status, started_at: span.startedAt, ended_at: span.endedAt ?? null, duration_ms: span.durationMs ?? null,
      model_id: span.modelId ?? null, input_tokens: span.inputTokens, output_tokens: span.outputTokens, cost: span.cost,
      attributes: span.attributes === undefined ? null : JSON.stringify(span.attributes), error_message: span.errorMessage ?? null,
    });
  }

  getTrace(runId: string): RunTrace | undefined {
    const runRow = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as TraceRunRow | undefined;
    if (!runRow) return undefined;
    const spanRows = this.db.prepare('SELECT * FROM spans WHERE run_id = ? ORDER BY started_at ASC').all(runId) as TraceSpanRow[];
    return { run: toTraceRun(runRow), spans: spanRows.map(toTraceSpan) };
  }

  getTraceRetention(): { maxAgeDays: number; maxRuns: number } {
    try {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('trace_retention') as { value: string } | undefined;
      const parsed = row ? JSON.parse(row.value) as { maxAgeDays?: unknown; maxRuns?: unknown } : {};
      return {
        maxAgeDays: Number.isFinite(parsed.maxAgeDays) ? Math.max(1, Math.min(3650, Number(parsed.maxAgeDays))) : 30,
        maxRuns: Number.isFinite(parsed.maxRuns) ? Math.max(10, Math.min(100_000, Math.floor(Number(parsed.maxRuns)))) : 1_000,
      };
    } catch { return { maxAgeDays: 30, maxRuns: 1_000 }; }
  }

  setTraceRetention(options: { maxAgeDays?: number; maxRuns?: number }): { maxAgeDays: number; maxRuns: number } {
    const current = this.getTraceRetention();
    const next = {
      maxAgeDays: Number.isFinite(options.maxAgeDays) ? Math.max(1, Math.min(3650, Math.floor(options.maxAgeDays!))) : current.maxAgeDays,
      maxRuns: Number.isFinite(options.maxRuns) ? Math.max(10, Math.min(100_000, Math.floor(options.maxRuns!))) : current.maxRuns,
    };
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('trace_retention', JSON.stringify(next));
    return next;
  }

  clearTraces(): { runs: number; spans: number } {
    return this.db.transaction(() => {
      const spans = this.db.prepare('DELETE FROM spans').run().changes;
      const runs = this.db.prepare('DELETE FROM runs').run().changes;
      return { runs, spans };
    })();
  }

  /** Remove old/excess traces; returns the number of runs and spans deleted. */
  pruneTraces(options: { maxAgeDays?: number; maxRuns?: number; now?: Date } = {}): { runs: number; spans: number } {
    const maxAgeDays = Number.isFinite(options.maxAgeDays) ? Math.max(0, options.maxAgeDays!) : 30;
    const maxRuns = Number.isFinite(options.maxRuns) ? Math.max(1, Math.floor(options.maxRuns!)) : 1_000;
    const cutoff = new Date((options.now ?? new Date()).getTime() - maxAgeDays * 86_400_000).toISOString();
    const ids = this.db.prepare(
      `SELECT id FROM runs WHERE started_at < ? OR id NOT IN (SELECT id FROM runs ORDER BY started_at DESC LIMIT ?)`,
    ).all(cutoff, maxRuns) as Array<{ id: string }>;
    if (!ids.length) return { runs: 0, spans: 0 };
    const placeholders = ids.map(() => '?').join(',');
    const values = ids.map((row) => row.id);
    return this.db.transaction(() => {
      const spans = this.db.prepare(`DELETE FROM spans WHERE run_id IN (${placeholders})`).run(...values).changes;
      const runs = this.db.prepare(`DELETE FROM runs WHERE id IN (${placeholders})`).run(...values).changes;
      return { runs, spans };
    })();
  }

  listTraceRuns(sessionId: string, limit = 20): TraceRunRecord[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 20;
    const rows = this.db.prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?').all(sessionId, safeLimit) as TraceRunRow[];
    return rows.map(toTraceRun);
  }

  recordAuditResult(input: { taskId: string; modelId?: string; approved: boolean; score?: number; createdAt?: Date }): AuditMetric {
    const result: AuditMetric = { id: randomUUID(), taskId: input.taskId, modelId: input.modelId, approved: input.approved, score: input.score, createdAt: input.createdAt ?? new Date() };
    this.db.prepare('INSERT INTO audit_results (id, task_id, model_id, approved, score, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(result.id, result.taskId, result.modelId ?? null, result.approved ? 1 : 0, result.score ?? null, result.createdAt.toISOString());
    return result;
  }

  getTaskMetrics(taskId: string): TaskMetrics {
    const rows = this.rows({ taskId });
    const success = rows.filter(row => row.status === 'success').length;
    return { taskId, totalInvocations: rows.length, modelsUsed: [...new Set(rows.map(row => row.model_id))], totalTokens: rows.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0), totalCost: rows.reduce((sum, row) => sum + row.total_cost, 0), successRate: rows.length ? success / rows.length : 0, avgLatency: rows.length ? rows.reduce((sum, row) => sum + (row.latency ?? 0), 0) / rows.length : 0 };
  }

  getRecent(limit = 20): ModelInvocation[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
    const rows = this.db.prepare('SELECT * FROM invocations ORDER BY start_time DESC LIMIT ?').all(safeLimit) as InvocationRow[];
    return rows.map(row => this.toInvocation(row));
  }

  getInvocations(range: MetricsTimeRange = {}): ModelInvocation[] {
    return this.rows({ range }).map(row => this.toInvocation(row));
  }

  getSummary(range: MetricsTimeRange = {}): MetricsSummary {
    const rows = this.rows({ range });
    const audits = this.auditRows(range);
    const successful = rows.filter(row => row.status === 'success').length;
    const completed = rows.filter(row => row.latency !== null);
    return {
      totalInvocations: rows.length,
      totalTasks: new Set(rows.map(row => row.task_id)).size,
      totalTokens: rows.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0),
      totalCost: rows.reduce((sum, row) => sum + row.total_cost, 0),
      successRate: rows.length ? successful / rows.length : 0,
      avgLatency: completed.length ? completed.reduce((sum, row) => sum + Number(row.latency ?? 0), 0) / completed.length : 0,
      auditCount: audits.length,
      auditPassRate: audits.length ? audits.filter(row => row.approved === 1).length / audits.length : 0,
    };
  }

  getModelMetrics(range: MetricsTimeRange = {}): ModelMetrics[] {
    const rows = this.rows({ range });
    const total = rows.length;
    const grouped = new Map<string, InvocationRow[]>();
    for (const row of rows) grouped.set(row.model_id, [...(grouped.get(row.model_id) ?? []), row]);
    return [...grouped.entries()].map(([modelId, values]) => {
      const successful = values.filter(row => row.status === 'success').length;
      const completed = values.filter(row => row.latency !== null);
      return { modelId, invocations: values.length, successfulInvocations: successful, successRate: values.length ? successful / values.length : 0, inputTokens: values.reduce((sum, row) => sum + row.input_tokens, 0), outputTokens: values.reduce((sum, row) => sum + row.output_tokens, 0), totalTokens: values.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0), totalCost: values.reduce((sum, row) => sum + row.total_cost, 0), avgLatency: completed.length ? completed.reduce((sum, row) => sum + Number(row.latency ?? 0), 0) / completed.length : 0, share: total ? values.length / total : 0 };
    }).sort((a, b) => b.invocations - a.invocations || a.modelId.localeCompare(b.modelId));
  }

  getCostTrend(range: MetricsTimeRange = {}, bucket: 'hour' | 'day' = 'day'): CostTrendPoint[] {
    const grouped = new Map<string, CostTrendPoint>();
    for (const row of this.rows({ range })) {
      const date = new Date(row.start_time);
      const key = bucket === 'hour' ? `${date.toISOString().slice(0, 13)}:00:00.000Z` : date.toISOString().slice(0, 10);
      const current = grouped.get(key) ?? { bucket: key, invocations: 0, totalTokens: 0, totalCost: 0 };
      current.invocations += 1;
      current.totalTokens += row.input_tokens + row.output_tokens;
      current.totalCost += row.total_cost;
      grouped.set(key, current);
    }
    return [...grouped.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  }

  getReport(range: MetricsTimeRange = {}, recentLimit = 20): ObservabilityReport {
    const normalized = { from: this.asDate(range.from), to: this.asDate(range.to) };
    return { generatedAt: new Date(), range: normalized, summary: this.getSummary(normalized), models: this.getModelMetrics(normalized), costTrend: this.getCostTrend(normalized), recent: this.getInvocations(normalized).sort((a, b) => b.startTime.getTime() - a.startTime.getTime()).slice(0, Math.max(1, recentLimit)) };
  }

  getDashboardSnapshot(options: MetricsTimeRange = {}): DashboardSnapshot {
    const report = this.getReport(options);
    return { generatedAt: report.generatedAt, range: report.range, summary: report.summary, modelUsage: report.models, costTrend: report.costTrend, recent: report.recent };
  }

  getReportMarkdown(options: MetricsTimeRange = {}): string {
    return this.exportReportMarkdown(this.getReport(options));
  }

  exportReportMarkdown(report: ObservabilityReport): string {
    const { summary } = report;
    const lines = ['# AMD Agent Observability Report', '', `Generated: ${report.generatedAt.toISOString()}`, '', '## Summary', '', `- Invocations: ${summary.totalInvocations}`, `- Tasks: ${summary.totalTasks}`, `- Total tokens: ${summary.totalTokens}`, `- Total cost: $${summary.totalCost.toFixed(6)}`, `- Success rate: ${(summary.successRate * 100).toFixed(1)}%`, `- Average latency: ${Math.round(summary.avgLatency)} ms`, `- Audit pass rate: ${summary.auditCount ? `${(summary.auditPassRate * 100).toFixed(1)}%` : 'n/a'}`, '', '## Models', '', '| Model | Invocations | Success | Cost | Share |', '| --- | ---: | ---: | ---: | ---: |'];
    for (const model of report.models) lines.push(`| ${model.modelId} | ${model.invocations} | ${(model.successRate * 100).toFixed(1)}% | $${model.totalCost.toFixed(6)} | ${(model.share * 100).toFixed(1)}% |`);
    lines.push('', '## Cost trend', '', '| Bucket | Invocations | Tokens | Cost |', '| --- | ---: | ---: | ---: |');
    for (const point of report.costTrend) lines.push(`| ${point.bucket} | ${point.invocations} | ${point.totalTokens} | $${point.totalCost.toFixed(6)} |`);
    return `${lines.join('\n')}\n`;
  }

  close(): void { this.db.close(); }

  private rows(options: { taskId?: string; range?: MetricsTimeRange } = {}): InvocationRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.taskId) { clauses.push('task_id = ?'); params.push(options.taskId); }
    this.addRangeClauses(clauses, params, options.range);
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM invocations${where} ORDER BY start_time ASC`).all(...params) as InvocationRow[];
  }

  private auditRows(range: MetricsTimeRange = {}): AuditRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    this.addRangeClauses(clauses, params, range, 'created_at');
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM audit_results${where} ORDER BY created_at ASC`).all(...params) as AuditRow[];
  }

  private addRangeClauses(clauses: string[], params: unknown[], range: MetricsTimeRange | undefined, column = 'start_time'): void {
    if (range?.from) { clauses.push(`${column} >= ?`); params.push(this.asDate(range.from)!.toISOString()); }
    if (range?.to) { clauses.push(`${column} <= ?`); params.push(this.asDate(range.to)!.toISOString()); }
  }

  private asDate(value: Date | string | undefined): Date | undefined { if (!value) return undefined; const result = value instanceof Date ? new Date(value.getTime()) : new Date(value); if (Number.isNaN(result.getTime())) throw new Error(`Invalid metrics date: ${String(value)}`); return result; }

  private toInvocation(row: InvocationRow): ModelInvocation { return { id: row.id, taskId: row.task_id, modelId: row.model_id, startTime: new Date(row.start_time), endTime: row.end_time ? new Date(row.end_time) : undefined, inputTokens: row.input_tokens, outputTokens: row.output_tokens, totalCost: row.total_cost, status: row.status, errorMessage: row.error_message ?? undefined, latency: row.latency ?? undefined }; }
}

function toTraceRun(row: TraceRunRow): TraceRunRecord {
  return {
    id: row.id, sessionId: row.session_id, taskType: row.task_type ?? undefined, complexity: row.complexity ?? undefined,
    status: row.status as TraceRunRecord['status'], startedAt: row.started_at, endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms ?? undefined, totalInputTokens: row.total_input_tokens, totalOutputTokens: row.total_output_tokens,
    totalCost: row.total_cost, errorMessage: row.error_message ?? undefined,
  };
}

function toTraceSpan(row: TraceSpanRow): TraceSpanRecord {
  let attributes: Record<string, unknown> | undefined;
  if (row.attributes) {
    try { attributes = JSON.parse(row.attributes) as Record<string, unknown>; } catch { attributes = undefined; }
  }
  return {
    id: row.id, runId: row.run_id, parentSpanId: row.parent_span_id ?? undefined,
    kind: row.kind as TraceSpanRecord['kind'], name: row.name, status: row.status as TraceSpanRecord['status'],
    startedAt: row.started_at, endedAt: row.ended_at ?? undefined, durationMs: row.duration_ms ?? undefined,
    modelId: row.model_id ?? undefined, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
    cost: row.cost, attributes, errorMessage: row.error_message ?? undefined,
  };
}
