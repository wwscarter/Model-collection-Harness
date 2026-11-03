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

export interface SessionMessageRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  modelUsed?: string;
  planningModelId?: string;
  agents?: SessionAgentRecord[];
}

interface SessionRow { id: string; title: string; prompt: string; user_message: string | null; output: string; messages: string | null; model_used: string | null; metrics: string | null; audit_result: string | null; rating: number | null; created_at: string; updated_at: string; }

export class SessionStorage {
  private readonly db: Database.Database;
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, user_message TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '', messages TEXT NOT NULL DEFAULT '[]', model_used TEXT, metrics TEXT, audit_result TEXT, rating INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);`);
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'user_message')) this.db.exec("ALTER TABLE sessions ADD COLUMN user_message TEXT NOT NULL DEFAULT ''");
    if (!columns.some((column) => column.name === 'messages')) this.db.exec("ALTER TABLE sessions ADD COLUMN messages TEXT NOT NULL DEFAULT '[]'");
  }
  save(session: SessionRecord): SessionRecord {
    const messages = this.normalizeMessages(session.messages) ?? this.legacyMessages(session.userMessage, session.prompt, session.output, session.title);
    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content;
    const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')?.content;
    const record: SessionRecord = { ...session, messages, userMessage: lastUserMessage, output: lastAssistantMessage ?? session.output ?? '' };
    this.db.prepare(`INSERT INTO sessions (id,title,prompt,user_message,output,messages,model_used,metrics,audit_result,rating,created_at,updated_at) VALUES (@id,@title,@prompt,@user_message,@output,@messages,@model_used,@metrics,@audit_result,@rating,@created_at,@updated_at) ON CONFLICT(id) DO UPDATE SET title=excluded.title,prompt=excluded.prompt,user_message=excluded.user_message,output=excluded.output,messages=excluded.messages,model_used=excluded.model_used,metrics=excluded.metrics,audit_result=excluded.audit_result,rating=excluded.rating,updated_at=excluded.updated_at`).run({ id: record.id, title: record.title, prompt: record.prompt, user_message: record.userMessage ?? '', output: record.output ?? '', messages: JSON.stringify(messages), model_used: record.modelUsed ?? null, metrics: record.metrics === undefined ? null : JSON.stringify(record.metrics), audit_result: record.auditResult === undefined ? null : JSON.stringify(record.auditResult), rating: record.rating ?? null, created_at: record.createdAt.toISOString(), updated_at: record.updatedAt.toISOString() });
    return { ...record, createdAt: new Date(record.createdAt), updatedAt: new Date(record.updatedAt) };
  }
  list(): SessionRecord[] { const rows = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as SessionRow[]; return rows.map((row) => this.fromRow(row)); }
  get(id: string): SessionRecord | undefined { const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined; return row ? this.fromRow(row) : undefined; }
  delete(id: string): boolean { return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0; }
  close(): void { if (this.db.open) this.db.close(); }
  private fromRow(row: SessionRow): SessionRecord {
    const messages = this.normalizeMessages(row.messages ? JSON.parse(row.messages) as unknown : undefined) ?? this.legacyMessages(row.user_message, row.prompt, row.output, row.title);
    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content;
    const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')?.content;
    return { id: row.id, title: row.title, prompt: row.prompt, userMessage: lastUserMessage, output: lastAssistantMessage ?? row.output, messages, modelUsed: row.model_used ?? undefined, metrics: row.metrics ? JSON.parse(row.metrics) : undefined, auditResult: row.audit_result ? JSON.parse(row.audit_result) : undefined, rating: row.rating ?? undefined, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) };
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
        ...(Array.isArray(message.agents) ? { agents: this.normalizeAgents(message.agents) } : {}),
      }];
    });
    return messages.length ? messages : undefined;
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

  private legacyMessages(userMessage: string | null | undefined, prompt: string | null | undefined, output: string | null | undefined, title: string): SessionMessageRecord[] {
    const messages: SessionMessageRecord[] = [];
    const previousInput = userMessage?.trim() || prompt?.trim() || (output ? title : '');
    if (previousInput) messages.push({ id: 'legacy-user', role: 'user', content: previousInput });
    if (output) messages.push({ id: 'legacy-assistant', role: 'assistant', content: output });
    return messages;
  }
}
