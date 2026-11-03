import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AuditResult } from './CodeAuditor';

export interface AuditLogEntry {
  sequence: number;
  timestamp: string;
  taskId: string;
  originalModelId: string;
  auditModelId: string;
  contentHash: string;
  overallScore: number;
  approval: boolean;
  issues: AuditResult['issues'];
  previousHash: string;
  entryHash: string;
}

/** Append-only JSONL audit trail with a hash chain. */
export class AuditLog {
  constructor(private readonly filePath: string) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', { mode: 0o600 });
  }

  append(result: AuditResult): AuditLogEntry {
    const entries = this.readEntries();
    const previousHash = entries.at(-1)?.entryHash ?? 'GENESIS';
    const body = { sequence: entries.length + 1, timestamp: result.timestamp.toISOString(), taskId: result.taskId, originalModelId: result.originalModelId, auditModelId: result.auditModelId, contentHash: result.contentHash, overallScore: result.overallScore, approval: result.approval, issues: result.issues, previousHash };
    const entryHash = this.hash(body);
    const entry: AuditLogEntry = { ...body, entryHash };
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    return entry;
  }

  readEntries(): AuditLogEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as AuditLogEntry);
  }

  verify(): { valid: boolean; entries: number; error?: string } {
    try {
      const entries = this.readEntries();
      let previousHash = 'GENESIS';
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const { entryHash, ...body } = entry;
        if (entry.sequence !== index + 1 || entry.previousHash !== previousHash || this.hash(body) !== entryHash) return { valid: false, entries: entries.length, error: `Invalid audit entry ${entry.sequence}` };
        previousHash = entryHash;
      }
      return { valid: true, entries: entries.length };
    } catch (error) {
      return { valid: false, entries: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private hash(value: object): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
