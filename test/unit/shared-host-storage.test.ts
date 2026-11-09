import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelStorage } from '../../src/core/storage/ModelStorage';
import { SessionStorage } from '../../src/core/storage/SessionStorage';
import { ProjectStorage } from '../../src/core/storage/ProjectStorage';
import { MemoryStore } from '../../src/core/memory/MemoryStore';
import { ObservabilityEngine } from '../../src/core/observability/ObservabilityEngine';
import { readEnvironmentModel } from '../../src/core/bootstrap/environmentModel';

interface Writer { table: string; write(index: number): void; close(): void }
const writers: Array<[string, (file: string) => Writer]> = [
  ['sessions', (file) => { const store = new SessionStorage(file); return { table: 'sessions', write: (index) => store.save({ id: String(index), title: 'ordinary', prompt: 'ordinary', output: 'ordinary', createdAt: new Date(), updatedAt: new Date() }), close: () => store.close() }; }],
  ['models', (file) => { const store = new ModelStorage(file); const model = readEnvironmentModel({ NEWAI_MODEL_ID: 'ordinary', NEWAI_BASE_URL: 'http://127.0.0.1:12345/v1' })!; return { table: 'models', write: (index) => store.saveModel({ ...model, id: String(index) }), close: () => store.close() }; }],
  ['projects', (file) => { const store = new ProjectStorage(file); return { table: 'workspace_projects', write: (index) => store.recordOpened('/ordinary-project-' + index), close: () => store.close() }; }],
  ['memory', (file) => { const store = new MemoryStore(file); return { table: 'memories', write: (index) => store.add({ content: 'Ordinary project note number ' + index }), close: () => store.close() }; }],
  ['metrics', (file) => { const store = new ObservabilityEngine(file); return { table: 'runs', write: (index) => store.saveTraceRun({ id: String(index), sessionId: 'ordinary-session', status: 'running', startedAt: new Date().toISOString(), totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 }), close: () => store.close() }; }],
];

describe('shared desktop and CLI SQLite stores', () => {
  it.each(writers)('commits %s while another host retains a read snapshot', (_name, create) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-shared-sqlite-'));
    const file = path.join(root, 'shared.db');
    const writer = create(file);
    const reader = new Database(file, { readonly: true });
    const count = () => (reader.prepare('SELECT COUNT(*) AS n FROM ' + writer.table).get() as { n: number }).n;
    try {
      writer.write(1);
      reader.exec('BEGIN');
      expect(count()).toBe(1);
      writer.write(2);
      expect(count()).toBe(1);
      reader.exec('COMMIT');
      expect(count()).toBe(2);
    } finally { reader.close(); writer.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
