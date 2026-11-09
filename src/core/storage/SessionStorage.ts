import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface SessionRecord {
  id: string;
  title: string;
  prompt: string;
  userMessage?: string;
  output: string;
  messages?: SessionMessageRecord[];
  modelUsed?: string;
  /** Session-level routing preference: true enables automatic multi-model routing. */
  multiModel?: boolean;
  /** Pinned execution model when multi-model routing is off. */
  modelId?: string;
  /** Project associated with this conversation. */
  projectId?: string;
  projectRoot?: string;
  /** Per-turn run id used by traces; distinct from the session id. */
  runId?: string;
  /** Deterministic/LLM summary of older turns. */
  summary?: string;
  summaryCoversTo?: number;
  summaryHash?: string;
  summaryTokens?: number;
  summaryUpdatedAt?: Date;
  metrics?: unknown;
  auditResult?: unknown;
  rating?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionAgentRecord {
  id: string;
  modelId: string;
  modelName: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  content: string;
  error?: string;
}

/** A tool call shown on an assistant message (web search, page fetch, file read). */
export interface SessionToolRecord {
  id: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  label?: string;
  summary?: string;
  durationMs?: number;
}

export interface SessionMessageRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  modelUsed?: string;
  planningModelId?: string;
  durationMs?: number;
  agents?: SessionAgentRecord[];
  tools?: SessionToolRecord[];
}

interface SessionRow { id: string; title: string; prompt: string; user_message: string | null; output: string; messages: string | null; model_used: string | null; multi_model: number | null; model_id: string | null; project_id: string | null; project_root: string | null; last_run_id: string | null; summary: string | null; summary_covers_to: number | null; summary_hash: string | null; summary_tokens: number | null; summary_updated_at: string | null; metrics: string | null; audit_result: string | null; rating: number | null; created_at: string; updated_at: string; }

export interface SessionSummaryRecord {
  text: string;
  coversTo: number;
  hash?: string;
  tokens?: number;
  updatedAt: Date;
}

export class SessionStorage {
  private readonly db: Database.Database;
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, user_message TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '', messages TEXT NOT NULL DEFAULT '[]', model_used TEXT, last_run_id TEXT, summary TEXT, summary_covers_to INTEGER, summary_hash TEXT, summary_tokens INTEGER, summary_updated_at TEXT, metrics TEXT, audit_result TEXT, rating INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);`);
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'user_message')) this.db.exec("ALTER TABLE sessions ADD COLUMN user_message TEXT NOT NULL DEFAULT ''");
    if (!columns.some((column) => column.name === 'messages')) this.db.exec("ALTER TABLE sessions ADD COLUMN messages TEXT NOT NULL DEFAULT '[]'");
    if (!columns.some((column) => column.name === 'last_run_id')) this.db.exec("ALTER TABLE sessions ADD COLUMN last_run_id TEXT");
    if (!columns.some((column) => column.name === 'summary')) this.db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT");
    if (!columns.some((column) => column.name === 'summary_covers_to')) this.db.exec("ALTER TABLE sessions ADD COLUMN summary_covers_to INTEGER");
    if (!columns.some((column) => column.name === 'summary_hash')) this.db.exec("ALTER TABLE sessions ADD COLUMN summary_hash TEXT");
    if (!columns.some((column) => column.name === 'summary_tokens')) this.db.exec("ALTER TABLE sessions ADD COLUMN summary_tokens INTEGER");
    if (!columns.some((column) => column.name === 'summary_updated_at')) this.db.exec("ALTER TABLE sessions ADD COLUMN summary_updated_at TEXT");
    if (!columns.some((column) => column.name === 'multi_model')) this.db.exec('ALTER TABLE sessions ADD COLUMN multi_model INTEGER');
    if (!columns.some((column) => column.name === 'model_id')) this.db.exec('ALTER TABLE sessions ADD COLUMN model_id TEXT');
    if (!columns.some((column) => column.name === 'project_id')) this.db.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT');
    if (!columns.some((column) => column.name === 'project_root')) this.db.exec('ALTER TABLE sessions ADD COLUMN project_root TEXT');
  }
  save(session: SessionRecord): SessionRecord {
    const normalized = this.normalizeMessages(session.messages);
    const messages = normalized ?? this.legacyMessages(session.userMessage, session.prompt, session.output, session.title);
    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content;
    const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')?.content;
    const record: SessionRecord = { ...session, messages, userMessage: lastUserMessage, output: lastAssistantMessage ?? (normalized ? '' : session.output ?? '') };
    this.db.prepare(`INSERT INTO sessions (id,title,prompt,user_message,output,messages,model_used,multi_model,model_id,project_id,project_root,last_run_id,metrics,audit_result,rating,created_at,updated_at) VALUES (@id,@title,@prompt,@user_message,@output,@messages,@model_used,@multi_model,@model_id,@project_id,@project_root,@last_run_id,@metrics,@audit_result,@rating,@created_at,@updated_at) ON CONFLICT(id) DO UPDATE SET title=excluded.title,prompt=excluded.prompt,user_message=excluded.user_message,output=excluded.output,messages=excluded.messages,model_used=excluded.model_used,multi_model=excluded.multi_model,model_id=excluded.model_id,project_id=excluded.project_id,project_root=excluded.project_root,last_run_id=excluded.last_run_id,metrics=excluded.metrics,audit_result=excluded.audit_result,rating=excluded.rating,updated_at=excluded.updated_at`).run({ id: record.id, title: record.title, prompt: record.prompt, user_message: record.userMessage ?? '', output: record.output ?? '', messages: JSON.stringify(messages), model_used: record.modelUsed ?? null, multi_model: record.multiModel === false ? 0 : 1, model_id: record.modelId ?? null, project_id: record.projectId ?? null, project_root: record.projectRoot ?? null, last_run_id: record.runId ?? null, metrics: record.metrics === undefined ? null : JSON.stringify(record.metrics), audit_result: record.auditResult === undefined ? null : JSON.stringify(record.auditResult), rating: record.rating ?? null, created_at: record.createdAt.toISOString(), updated_at: record.updatedAt.toISOString() });
    return { ...record, createdAt: new Date(record.createdAt), updatedAt: new Date(record.updatedAt) };
  }
  list(): SessionRecord[] { const rows = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as SessionRow[]; return rows.map((row) => this.fromRow(row)); }
  get(id: string): SessionRecord | undefined { const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined; return row ? this.fromRow(row) : undefined; }
  getSummary(id: string): SessionSummaryRecord | undefined {
    const row = this.db.prepare('SELECT summary, summary_covers_to, summary_hash, summary_tokens, summary_updated_at FROM sessions WHERE id = ?').get(id) as Pick<SessionRow, 'summary' | 'summary_covers_to' | 'summary_hash' | 'summary_tokens' | 'summary_updated_at'> | undefined;
    if (!row?.summary || !row.summary_covers_to) return undefined;
    return {
      text: row.summary,
      coversTo: row.summary_covers_to,
      hash: row.summary_hash ?? undefined,
      tokens: row.summary_tokens ?? undefined,
      updatedAt: row.summary_updated_at ? new Date(row.summary_updated_at) : new Date(),
    };
  }
  saveSummary(id: string, summary: Omit<SessionSummaryRecord, 'updatedAt'> & { updatedAt?: Date }): boolean {
    return this.db.prepare('UPDATE sessions SET summary = ?, summary_covers_to = ?, summary_hash = ?, summary_tokens = ?, summary_updated_at = ? WHERE id = ?')
      .run(summary.text, summary.coversTo, summary.hash ?? null, summary.tokens ?? null, (summary.updatedAt ?? new Date()).toISOString(), id).changes > 0;
  }
  delete(id: string): boolean { return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0; }
  close(): void { if (this.db.open) this.db.close(); }
  private fromRow(row: SessionRow): SessionRecord {
    // One damaged JSON column must not break the whole session list. Degrade to
    // the legacy text fields and let the user keep working.
    const normalized = this.normalizeMessages(parseJson<unknown>(row.messages, undefined));
    // Empty histories are intentional for drafts. Legacy rows have submitted
    // input/output in their separate columns and still need reconstruction.
    const messages = normalized && (normalized.length || (!row.user_message && !row.output))
      ? normalized : this.legacyMessages(row.user_message, row.prompt, row.output, row.title);
    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content;
    const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')?.content;
    return { id: row.id, title: row.title, prompt: row.prompt, userMessage: lastUserMessage, output: lastAssistantMessage ?? row.output, messages, modelUsed: row.model_used ?? undefined, multiModel: row.multi_model === 0 ? false : true, modelId: row.model_id ?? undefined, projectId: row.project_id ?? undefined, projectRoot: row.project_root ?? undefined, runId: row.last_run_id ?? undefined, summary: row.summary ?? undefined, summaryCoversTo: row.summary_covers_to ?? undefined, summaryHash: row.summary_hash ?? undefined, summaryTokens: row.summary_tokens ?? undefined, summaryUpdatedAt: row.summary_updated_at ? new Date(row.summary_updated_at) : undefined, metrics: parseJson<unknown>(row.metrics, undefined), auditResult: parseJson<unknown>(row.audit_result, undefined), rating: row.rating ?? undefined, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) };
  }

  private normalizeMessages(value: unknown): SessionMessageRecord[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const messages = value.flatMap((value): SessionMessageRecord[] => {
      if (!value || typeof value !== 'object') return [];
      const message = value as Partial<SessionMessageRecord>;
      if (typeof message.id !== 'string' || (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') return [];
      return [{
        id: message.id,
        role: message.role,
        content: message.content,
        ...(typeof message.modelUsed === 'string' ? { modelUsed: message.modelUsed } : {}),
        ...(typeof message.planningModelId === 'string' ? { planningModelId: message.planningModelId } : {}),
        ...(typeof message.durationMs === 'number' && Number.isFinite(message.durationMs) ? { durationMs: message.durationMs } : {}),
        ...(Array.isArray(message.agents) ? { agents: this.normalizeAgents(message.agents) } : {}),
        ...(Array.isArray(message.tools) ? { tools: this.normalizeTools(message.tools) } : {}),
      }];
    });
    return messages.length || value.length === 0 ? messages : undefined;
  }

  private normalizeAgents(value: unknown[]): SessionAgentRecord[] {
    return value.flatMap((value): SessionAgentRecord[] => {
      if (!value || typeof value !== 'object') return [];
      const agent = value as Partial<SessionAgentRecord>;
      if (typeof agent.id !== 'string' || typeof agent.modelId !== 'string' || typeof agent.modelName !== 'string' || typeof agent.content !== 'string') return [];
      if (agent.status !== 'queued' && agent.status !== 'running' && agent.status !== 'completed' && agent.status !== 'failed') return [];
      return [{
        id: agent.id,
        modelId: agent.modelId,
        modelName: agent.modelName,
        status: agent.status,
        content: agent.content,
        ...(typeof agent.error === 'string' ? { error: agent.error } : {}),
      }];
    });
  }

  private normalizeTools(value: unknown[]): SessionToolRecord[] {
    return value.slice(0, 50).flatMap((value): SessionToolRecord[] => {
      if (!value || typeof value !== 'object') return [];
      const tool = value as Partial<SessionToolRecord>;
      if (typeof tool.id !== 'string' || typeof tool.toolName !== 'string') return [];
      if (tool.status !== 'running' && tool.status !== 'completed' && tool.status !== 'failed') return [];
      return [{
        id: tool.id,
        toolName: tool.toolName,
        status: tool.status,
        ...(typeof tool.label === 'string' ? { label: tool.label.slice(0, 300) } : {}),
        ...(typeof tool.summary === 'string' ? { summary: tool.summary.slice(0, 500) } : {}),
        ...(typeof tool.durationMs === 'number' && Number.isFinite(tool.durationMs) ? { durationMs: tool.durationMs } : {}),
      }];
    });
  }

  private legacyMessages(userMessage: string | null | undefined, prompt: string | null | undefined, output: string | null | undefined, title: string): SessionMessageRecord[] {
    const messages: SessionMessageRecord[] = [];
    const previousInput = userMessage?.trim() || prompt?.trim() || (output ? title : '');
    if (previousInput) messages.push({ id: 'legacy-user', role: 'user', content: previousInput });
    if (output) messages.push({ id: 'legacy-assistant', role: 'assistant', content: output });
    return messages;
  }
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
