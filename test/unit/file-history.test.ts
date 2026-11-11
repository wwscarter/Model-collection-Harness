import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileHistoryStore } from '../../src/core/storage/FileHistoryStore';

let projectRoot = '';
let store: FileHistoryStore;

beforeEach(() => {
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-file-history-')));
  store = new FileHistoryStore(':memory:');
});
afterEach(() => {
  store.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const target = (name: string) => ({ path: path.join(projectRoot, name), relativePath: name });

async function record(runId: string, name: string, before: string | undefined, after: string) {
  const recorder = store.recorder({ runId, sessionId: 'session-1', projectRoot });
  if (before !== undefined) fs.writeFileSync(target(name).path, before);
  await recorder.beforeWrite(target(name));
  fs.writeFileSync(target(name).path, after);
  await recorder.afterWrite({ ...target(name), content: after });
  return recorder;
}

describe('FileHistoryStore', () => {
  it('restores a modified file to its pre-run content', async () => {
    await record('run-1', 'config.json', '{"version":1}', '{"version":2}');
    expect(store.list('run-1')).toMatchObject([{ relativePath: 'config.json', existed: true, beforeAvailable: true }]);
    expect(store.hasChanges('run-1')).toBe(true);

    await expect(store.restore('run-1')).resolves.toEqual({ restored: ['config.json'], skipped: [] });
    expect(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8')).toBe('{"version":1}');
    expect(store.list('run-1')[0].restoredAt).toBeTruthy();
    // A second restore has nothing left to do.
    await expect(store.restore('run-1')).resolves.toEqual({ restored: [], skipped: [] });
  });

  it('removes files the run created and restores the first snapshot of a file written twice', async () => {
    await record('run-2', 'created.txt', undefined, 'created');
    const recorder = store.recorder({ runId: 'run-2', sessionId: 'session-1', projectRoot });
    fs.writeFileSync(target('existing.txt').path, 'original');
    await recorder.beforeWrite(target('existing.txt'));
    fs.writeFileSync(target('existing.txt').path, 'first');
    await recorder.afterWrite({ ...target('existing.txt'), content: 'first' });
    fs.writeFileSync(target('existing.txt').path, 'second');
    await recorder.afterWrite({ ...target('existing.txt'), content: 'second' });

    await expect(store.restore('run-2')).resolves.toMatchObject({ restored: ['created.txt', 'existing.txt'], skipped: [] });
    expect(fs.existsSync(path.join(projectRoot, 'created.txt'))).toBe(false);
    // The first snapshot was kept, so the file returns to its pre-run content.
    expect(fs.readFileSync(path.join(projectRoot, 'existing.txt'), 'utf8')).toBe('original');
  });

  it('skips a file that changed after the run instead of clobbering newer edits', async () => {
    await record('run-3', 'notes.md', 'before', 'agent wrote this');
    fs.writeFileSync(path.join(projectRoot, 'notes.md'), 'user edited after the run');
    const result = await store.restore('run-3');
    expect(result.restored).toEqual([]);
    expect(result.skipped).toMatchObject([{ path: 'notes.md', reason: expect.stringContaining('又被修改') }]);
    expect(fs.readFileSync(path.join(projectRoot, 'notes.md'), 'utf8')).toBe('user edited after the run');
  });

  it('lists but does not snapshot files larger than the limit', async () => {
    const large = 'x'.repeat(1024 * 1024 + 1);
    await record('run-4', 'bundle.js', large, 'small replacement');
    expect(store.list('run-4')).toMatchObject([{ relativePath: 'bundle.js', existed: true, beforeAvailable: false }]);
    const result = await store.restore('run-4');
    expect(result.skipped).toMatchObject([{ path: 'bundle.js', reason: expect.stringContaining('1 MiB') }]);
  });

  it('refuses credential files and missing post-write hashes', async () => {
    const recorder = store.recorder({ runId: 'run-5', sessionId: 'session-1', projectRoot });
    fs.writeFileSync(path.join(projectRoot, '.env'), 'TOKEN=secret');
    await recorder.beforeWrite(target('.env'));
    fs.writeFileSync(path.join(projectRoot, '.env'), 'TOKEN=other');
    await recorder.afterWrite({ ...target('.env'), content: 'TOKEN=other' });

    await recorder.beforeWrite(target('no-hash.txt'));
    fs.writeFileSync(target('no-hash.txt').path, 'written');
    // No afterWrite: the store cannot prove the file still matches the run.
    const result = await store.restore('run-5');
    expect(result.skipped).toEqual(expect.arrayContaining([{ path: '.env', reason: expect.stringContaining('凭据') }, { path: 'no-hash.txt', reason: expect.stringContaining('缺少写入后校验') }]));
  });

  it('keeps runs independent', async () => {
    await record('run-a', 'a.txt', 'a-before', 'a-after');
    await record('run-b', 'b.txt', 'b-before', 'b-after');
    await expect(store.restore('run-a')).resolves.toMatchObject({ restored: ['a.txt'] });
    expect(store.list('run-b')[0].restoredAt).toBeUndefined();
    expect(fs.readFileSync(path.join(projectRoot, 'b.txt'), 'utf8')).toBe('b-after');
    store.deleteRun('run-b');
    expect(store.list('run-b')).toEqual([]);
  });
});
