import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStorage } from '../../src/core/storage/SessionStorage';

describe('SessionStorage', () => {
  it('saves media-only assistant answers as metadata and drops bytes and arbitrary URLs', () => {
    const storage = new SessionStorage(':memory:');
    const now = new Date();
    try {
      storage.save({ id: 'media', title: 'Image request', prompt: '', output: '', createdAt: now, updatedAt: now, messages: [{ id: 'a1', role: 'assistant', content: '', artifacts: [{ id: 'asset-1', kind: 'image', mimeType: 'image/png', fileName: '/private/generated.png', modelId: 'image-model', configurationId: 'config-1', jobId: 'job-1', width: 1024, height: 1024, bytes: 'secret', url: 'https://example.com/private' } as never], mediaJobs: [{ id: 'job-1', operation: 'image.generate', status: 'succeeded' }] }] });
      const message = storage.get('media')!.messages![0];
      expect(message.artifacts).toEqual([{ id: 'asset-1', kind: 'image', mimeType: 'image/png', fileName: 'generated.png', modelId: 'image-model', configurationId: 'config-1', jobId: 'job-1', width: 1024, height: 1024 }]);
      expect(message.mediaJobs).toEqual([{ id: 'job-1', operation: 'image.generate', status: 'succeeded' }]);
      expect(message.content).toBe('');
    } finally { storage.close(); }
  });
  it('keeps an unsent draft out of the conversation history after saving and reopening', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-draft-session-'));
    const file = path.join(directory, 'sessions.db');
    const storage = new SessionStorage(file);
    const now = new Date();
    try {
      const saved = storage.save({ id: 'draft', title: 'New conversation', prompt: 'An unsent draft', output: '', messages: [], createdAt: now, updatedAt: now });
      expect(saved.messages).toEqual([]);
      expect(saved.userMessage).toBeUndefined();
      storage.close();
      const reopened = new SessionStorage(file);
      try { expect(reopened.get('draft')).toMatchObject({ prompt: 'An unsent draft', messages: [], output: '' }); }
      finally { reopened.close(); }
    } finally {
      storage.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not resurrect an old answer when an explicit message history is cleared', () => {
    const storage = new SessionStorage(':memory:');
    const now = new Date();
    try {
      const original = storage.save({ id: 'cleared', title: 'Earlier conversation', prompt: '', userMessage: 'Earlier request', output: 'Earlier answer', createdAt: now, updatedAt: now });
      storage.save({ ...original, prompt: 'New unsent draft', messages: [] });
      expect(storage.get('cleared')).toMatchObject({ messages: [], prompt: 'New unsent draft', output: '' });
      expect(storage.get('cleared')!.userMessage).toBeUndefined();
    } finally { storage.close(); }
  });

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

  it('persists per-session routing and assistant duration', () => {
    const storage = new SessionStorage(':memory:');
    const now = new Date('2026-01-01T00:00:00.000Z');
    storage.save({ id: 'single', title: 'Single', prompt: '', output: 'done', multiModel: false, modelId: 'deepseek-chat', projectId: 'project-1', projectRoot: '/tmp/project', messages: [
      { id: 'a1', role: 'assistant', content: 'done', modelUsed: 'deepseek-chat', durationMs: 1234 },
    ], createdAt: now, updatedAt: now });
    const loaded = storage.get('single');
    expect(loaded?.multiModel).toBe(false);
    expect(loaded?.modelId).toBe('deepseek-chat');
    expect(loaded?.projectId).toBe('project-1');
    expect(loaded?.projectRoot).toBe('/tmp/project');
    expect(loaded?.messages?.[0].durationMs).toBe(1234);
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
