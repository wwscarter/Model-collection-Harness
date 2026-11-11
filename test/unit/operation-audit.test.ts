import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OperationAuditLog } from '../../src/core/audit/OperationAuditLog';

let directory = '';
let store: OperationAuditLog;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-operation-audit-'));
  store = new OperationAuditLog(path.join(directory, 'operations.jsonl'));
});
afterEach(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('OperationAuditLog', () => {
  it('appends entries with increasing sequence numbers and reads newest last', () => {
    store.append({ type: 'file.write', actor: 'agent', result: 'success', path: 'src/a.ts', runId: 'run-1', sessionId: 'session-1' });
    store.append({ type: 'process.stop', actor: 'user', result: 'stopped', detail: 'process-1' });
    const entries = store.read(10);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(entries[0]).toMatchObject({ type: 'file.write', actor: 'agent', path: 'src/a.ts', runId: 'run-1', sessionId: 'session-1' });
    expect(store.read(1)).toMatchObject([{ sequence: 2, type: 'process.stop' }]);
    expect(store.all()).toHaveLength(2);
  });

  it('skips damaged lines instead of hiding the rest of the trail', () => {
    store.append({ type: 'command.execute', actor: 'agent', result: 'success', command: 'npm test' });
    fs.appendFileSync(path.join(directory, 'operations.jsonl'), '{"broken":\n');
    store.append({ type: 'file.write', actor: 'agent', result: 'success', path: 'b.ts' });
    expect(store.read(10).map((entry) => entry.type)).toEqual(['command.execute', 'file.write']);
  });

  it('prunes expired entries and keeps sequences moving forward', () => {
    store.append({ type: 'file.write', actor: 'agent', result: 'success', path: 'old.ts' }, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString());
    store.append({ type: 'file.write', actor: 'agent', result: 'success', path: 'new.ts' });
    store.prune();
    expect(store.read(10).map((entry) => entry.path)).toEqual(['new.ts']);
    expect(store.append({ type: 'file.write', actor: 'agent', result: 'success', path: 'next.ts' }).sequence).toBe(3);
  });

  it('records file writes through the recorder adapter and bounds long fields', () => {
    const recorder = store.fileRecorder({ runId: 'run-9', sessionId: 'session-9', actor: 'agent' });
    return recorder.afterWrite({ path: '/project/a.ts', relativePath: 'a.ts', content: 'x' }).then(() => {
      expect(store.read(1)).toMatchObject([{ type: 'file.write', runId: 'run-9', sessionId: 'session-9', path: 'a.ts', result: 'success' }]);
      const long = store.append({ type: 'command.execute', actor: 'agent', result: 'success', command: 'x'.repeat(5_000) });
      expect(long.command).toHaveLength(2_000);
    });
  });
});
