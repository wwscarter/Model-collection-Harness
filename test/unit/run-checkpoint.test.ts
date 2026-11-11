import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunCheckpointStore } from '../../src/core/storage/RunCheckpointStore';

let directory = '';
let file = '';
let store: RunCheckpointStore;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-checkpoints-'));
  file = path.join(directory, 'checkpoints.db');
  store = new RunCheckpointStore(file);
});
afterEach(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('RunCheckpointStore', () => {
  it('counts tools and records distinct successfully written files', () => {
    store.start({ runId: 'run-1', sessionId: 'session-1', prompt: 'fix the build' });
    store.tool({ runId: 'run-1', toolName: 'read', path: 'src/a.ts' });
    store.tool({ runId: 'run-1', toolName: 'write', path: 'src/a.ts' });
    store.tool({ runId: 'run-1', toolName: 'edit', path: 'src/a.ts' });
    store.tool({ runId: 'run-1', toolName: 'write', path: 'src/broken.ts', failed: true });
    store.finish('run-1', 'completed');
    expect(store.latest('session-1')).toMatchObject({ runId: 'run-1', status: 'completed', toolCalls: 4, modifiedFiles: ['src/a.ts'], lastTool: 'write' });
  });

  it('marks an unfinished run as interrupted on the next launch', () => {
    store.start({ runId: 'run-2', sessionId: 'session-2', prompt: 'refactor' });
    store.tool({ runId: 'run-2', toolName: 'write', path: 'src/x.ts' });
    store.close();

    store = new RunCheckpointStore(file);
    expect(store.latest('session-2')).toMatchObject({ status: 'interrupted', toolCalls: 1, modifiedFiles: ['src/x.ts'] });
    expect(store.interrupted()).toMatchObject([{ runId: 'run-2' }]);
    store.acknowledge('run-2');
    expect(store.latest('session-2')?.status).toBe('acknowledged');
    expect(store.interrupted()).toEqual([]);
  });

  it('keeps sessions independent and ignores unknown runs', () => {
    store.start({ runId: 'run-a', sessionId: 'session-a' });
    store.start({ runId: 'run-b', sessionId: 'session-b' });
    store.tool({ runId: 'run-missing', toolName: 'write', path: 'x' });
    store.finish('run-a', 'failed');
    expect(store.latest('session-a')?.status).toBe('failed');
    expect(store.latest('session-b')?.status).toBe('running');
    expect(store.latest('session-c')).toBeUndefined();
  });
});
