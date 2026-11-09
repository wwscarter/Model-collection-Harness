import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodebaseIndex } from '../../src/core/codebase/CodebaseIndex';
import type { IndexFile } from '../../src/core/codebase/CodebaseTypes';
import { IndexWorkerClient } from '../../src/core/codebase/IndexWorkerClient';

afterEach(() => vi.restoreAllMocks());

describe('background symbol indexing cancellation', () => {
  it('cancels an active worker request while preserving another queued request', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-worker-cancel-'));
    const client = new IndexWorkerClient();
    const file = (name: string): IndexFile => {
      const absolutePath = path.join(directory, name + '.ts');
      fs.writeFileSync(absolutePath, 'export function ' + name + '() {}');
      const stat = fs.statSync(absolutePath);
      return { path: name + '.ts', absolutePath, mtimeMs: stat.mtimeMs, size: stat.size };
    };
    try {
      const controller = new AbortController();
      const first = client.extract([file('first')], controller.signal);
      const rejected = expect(first).rejects.toThrow('cancel first request');
      const second = client.extract([file('second')]);
      await Promise.resolve();
      controller.abort(new Error('cancel first request'));
      await rejected;
      expect(await second).toMatchObject([{ path: 'second.ts', symbols: [{ name: 'second' }] }]);
    } finally { client.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('returns a queued refresh cancellation before the preceding refresh finishes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-queued-index-cancel-'));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'example.ts'), 'export function example() {}');
    const index = new CodebaseIndex(path.join(directory, 'data'));
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(IndexWorkerClient.prototype, 'extract').mockImplementationOnce(async (files) => {
      started();
      await gate;
      return files.map((file) => ({ ...file, hash: 'fixture', symbols: [], truncated: false }));
    });
    try {
      const first = index.refresh(project);
      await active;
      const controller = new AbortController();
      const queued = index.refresh(project, undefined, controller.signal);
      const rejected = expect(queued).rejects.toThrow('cancel queued refresh');
      controller.abort(new Error('cancel queued refresh'));
      await rejected;
      release();
      expect(await first).toMatchObject({ indexed: 1, errors: [] });
    } finally { release(); index.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
