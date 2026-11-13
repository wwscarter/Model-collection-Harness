import fs from 'node:fs';
import path from 'node:path';
import type { FileChangeRecorder } from '@core/tools/fileChanges';

export type OperationType = 'file.write' | 'command.execute' | 'process.stop';
export type OperationResult = 'success' | 'failed' | 'stopped';

export interface OperationAuditEntry {
  sequence: number;
  timestamp: string;
  type: OperationType;
  actor: 'agent' | 'user';
  result: OperationResult;
  sessionId?: string;
  runId?: string;
  path?: string;
  command?: string;
  detail?: string;
}

export interface OperationAuditRecord {
  type: OperationType;
  actor: 'agent' | 'user';
  result: OperationResult;
  sessionId?: string;
  runId?: string;
  path?: string;
  command?: string;
  detail?: string;
}

interface OperationAuditOptions {
  /** Entries kept when the log is pruned at startup. */
  maxEntries?: number;
  maxAgeDays?: number;
}

const MAX_ENTRIES = 20_000;
const MAX_AGE_DAYS = 30;
const MAX_FIELD_CHARS = 2_000;

function safeCommand(command: string): string {
  const name = /^\s*([\w./\\-]+)(?=\s|$)/u.exec(command)?.[1];
  if (!name) return '[命令参数已隐藏]';
  // Keep common development tasks recognizable. Arbitrary command arguments may be credentials.
  const task = /^\s*(npm|pnpm|yarn|git)\s+(test|build|lint|status|diff|run\s+(?:test|build|lint|dev))(?=\s|$)/u.exec(command);
  const visible = task ? task[1] + ' ' + task[2] : name;
  return (command.trim() === visible ? visible : visible + ' [参数已隐藏]').slice(0, MAX_FIELD_CHARS);
}

/**
 * Append-only operation trail for actions the app performs on the user's
 * project. It deliberately stays separate from `AuditLog`: that file is a
 * hash-chain of model code reviews, while this one answers "what did the agent
 * or the user actually change, and when".
 *
 * Entries are newline-delimited JSON; a damaged line is skipped on read instead
 * of hiding the rest of the history. The log is pruned at startup.
 */
export class OperationAuditLog {
  private sequence = 0;
  private readonly maxEntries: number;
  private readonly maxAgeDays: number;

  constructor(private readonly filePath: string, options: OperationAuditOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_ENTRIES);
    this.maxAgeDays = Math.max(1, options.maxAgeDays ?? MAX_AGE_DAYS);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', { mode: 0o600 });
    this.prune();
    this.sequence = this.read(1).at(-1)?.sequence ?? 0;
  }

  append(record: OperationAuditRecord, timestamp = new Date().toISOString()): OperationAuditEntry {
    const entry: OperationAuditEntry = {
      sequence: ++this.sequence,
      timestamp,
      type: record.type,
      actor: record.actor,
      result: record.result,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.runId ? { runId: record.runId } : {}),
      ...(record.path ? { path: record.path.slice(0, MAX_FIELD_CHARS) } : {}),
      ...(record.command ? { command: safeCommand(record.command) } : {}),
      ...(record.detail ? { detail: record.detail.slice(0, MAX_FIELD_CHARS) } : {}),
    };
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
    return entry;
  }

  /** Newest last, bounded by `limit`. */
  read(limit = 100): OperationAuditEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    const entries = fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/).flatMap((line): OperationAuditEntry[] => {
      if (!line.trim()) return [];
      try {
        const value = JSON.parse(line) as Partial<OperationAuditEntry>;
        if (typeof value.sequence !== 'number' || typeof value.timestamp !== 'string' || typeof value.type !== 'string'
          || (value.actor !== 'agent' && value.actor !== 'user') || !['success', 'failed', 'stopped'].includes(value.result ?? '')) return [];
        if (typeof value.command === 'string') value.command = safeCommand(value.command);
        return [value as OperationAuditEntry];
      } catch { return []; }
    });
    return entries.slice(-Math.max(1, Math.min(this.maxEntries, Math.floor(limit))));
  }

  /** Read the whole trail for export; bounded by the same ceiling as storage. */
  all(): OperationAuditEntry[] { return this.read(this.maxEntries); }

  prune(now = new Date()): void {
    if (!fs.existsSync(this.filePath)) return;
    const cutoff = now.getTime() - this.maxAgeDays * 24 * 60 * 60 * 1000;
    const kept = this.read(this.maxEntries).filter((entry) => {
      const time = Date.parse(entry.timestamp);
      return Number.isFinite(time) && time >= cutoff;
    });
    if (!kept.length) { fs.writeFileSync(this.filePath, '', { mode: 0o600 }); return; }
    const body = kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    const temporary = this.filePath + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  close(): void { /* synchronous appends keep nothing open */ }

  /** File-write audit adapter used by the agent's mutation tools. */
  fileRecorder(context: { runId: string; sessionId?: string; actor: 'agent' }): FileChangeRecorder {
    return {
      beforeWrite: async () => undefined,
      afterWrite: async ({ relativePath }) => {
        try {
          this.append({ type: 'file.write', actor: context.actor, result: 'success', runId: context.runId, ...(context.sessionId ? { sessionId: context.sessionId } : {}), path: relativePath });
        } catch (error) { console.warn('[operation-audit] 记录文件写入失败', error instanceof Error ? error.message : error); }
      },
    };
  }
}
