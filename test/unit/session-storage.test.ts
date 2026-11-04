import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStorage } from '../../src/core/storage/SessionStorage';

describe('SessionStorage', () => {
  it('round trips sessions and orders by updated time', () => {
    const storage = new SessionStorage(':memory:');
    const now = new Date('2026-01-01T00:00:00.000Z');
    storage.save({ id: 'a', title: 'A', prompt: '', userMessage: 'hello', output: 'world', runId: 'run-a', messages: [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'world' },
      { id: 'u2', role: 'user', content: 'follow up' },
      { id: 'a2', role: 'assistant', content: 'second reply', modelUsed: 'model-1' },
    ], metrics: { cost: 1 }, createdAt: now, updatedAt: now });
    const loaded = storage.get('a');
    expect(loaded?.userMessage).toBe('follow up');
    expect(loaded?.output).toBe('second reply');
    expect(loaded?.messages).toEqual([
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'world' },
      { id: 'u2', role: 'user', content: 'follow up' },
      { id: 'a2', role: 'assistant', content: 'second reply', modelUsed: 'model-1' },
    ]);
    expect(loaded?.metrics).toEqual({ cost: 1 });
    expect(loaded?.runId).toBe('run-a');
    expect(storage.saveSummary('a', { text: 'earlier summary', coversTo: 2, hash: 'abc', tokens: 12 })).toBe(true);
    expect(storage.getSummary('a')).toMatchObject({ text: 'earlier summary', coversTo: 2, hash: 'abc', tokens: 12 });
    expect(loaded?.createdAt).toEqual(now);
    expect(storage.delete('a')).toBe(true);
    expect(storage.get('a')).toBeUndefined();
    storage.close();
  });

  it('round trips planning attribution and parallel subagent reports', () => {
    const storage = new SessionStorage(':memory:');
    const now = new Date('2026-01-01T00:00:00.000Z');
    storage.save({
      id: 'parallel',
      title: 'Parallel analysis',
      prompt: '',
      output: 'Combined answer',
      messages: [
        { id: 'u1', role: 'user', content: 'Compare two approaches' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Combined answer',
          modelUsed: 'gpt-model',
          planningModelId: 'claude-planner',
          agents: [
            { id: 'agent-1', modelId: 'claude-model', modelName: 'Claude', status: 'completed', content: 'Approach A is safer.' },
            { id: 'agent-2', modelId: 'gemini-model', modelName: 'Gemini', status: 'failed', content: 'Partial report', error: 'Rate limit exceeded' },
          ],
        },
      ],
      createdAt: now,
      updatedAt: now,
    });

    expect(storage.get('parallel')?.messages?.[1]).toEqual({
      id: 'a1',
      role: 'assistant',
      content: 'Combined answer',
      modelUsed: 'gpt-model',
      planningModelId: 'claude-planner',
      agents: [
        { id: 'agent-1', modelId: 'claude-model', modelName: 'Claude', status: 'completed', content: 'Approach A is safer.' },
        { id: 'agent-2', modelId: 'gemini-model', modelName: 'Gemini', status: 'failed', content: 'Partial report', error: 'Rate limit exceeded' },
      ],
    });
    storage.close();
  });

  it('migrates existing session databases to retain submitted user messages', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-sessions-'));
    const dbPath = path.join(directory, 'sessions.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', model_used TEXT, metrics TEXT, audit_result TEXT, rating INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const now = '2026-01-01T00:00:00.000Z';
    legacyDb.prepare('INSERT INTO sessions (id,title,prompt,output,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('existing', 'Old prompt title', '', 'Old response', now, now);
    legacyDb.close();

    const storage = new SessionStorage(dbPath);
    const nowDate = new Date(now);
    storage.save({ id: 'legacy', title: 'Legacy', prompt: '', userMessage: 'Retained prompt', output: 'reply', createdAt: nowDate, updatedAt: nowDate });
    expect(storage.get('existing')?.messages).toEqual([
      { id: 'legacy-user', role: 'user', content: 'Old prompt title' },
      { id: 'legacy-assistant', role: 'assistant', content: 'Old response' },
    ]);
    expect(storage.get('legacy')?.userMessage).toBe('Retained prompt');
    const migratedDb = new Database(dbPath, { readonly: true });
    const columns = migratedDb.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('messages');
    migratedDb.close();
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
