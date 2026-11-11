import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectProjectFiles } from '@core/codebase/ProjectFiles';
import { createProjectSearchTools } from '@core/tools/projectSearchTools';
import { locateRipgrep } from '@core/tools/RipgrepSearchBackend';
import type { ProjectSearchOptions } from '@core/tools/projectSearchTypes';

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-search-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function file(name: string, content: string | Buffer): void {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function invoke(name: string, input: Record<string, unknown>, options: ProjectSearchOptions = { rgPath: null }, signal?: AbortSignal) {
  const tool = createProjectSearchTools(root, options).find((tool) => tool.name === name)!;
  return tool.execute('test-search', input, signal, undefined, {} as never);
}
function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.flatMap((part) => part.type === 'text' ? [part.text ?? ''] : []).join('\n');
}

describe('shared project file scan', () => {
  it('applies nested ignore rules and default build-directory exclusions', async () => {
    file('.gitignore', '*.generated.ts\nnotes/\n/root-only.txt\n');
    file('src/.gitignore', '!keep.generated.ts\nlocal.txt\n');
    file('src/keep.generated.ts', 'kept');
    file('src/skip.generated.ts', 'ignored');
    file('src/local.txt', 'ignored');
    file('src/root-only.txt', 'kept');
    file('root-only.txt', 'ignored');
    file('notes/draft.txt', 'ignored');
    file('node_modules/example/index.js', 'build data');
    file('dist/main.js', 'build data');
    file('src/main.ts', 'export const value = 42;');
    const result = await collectProjectFiles(root);
    expect(result.files.map((entry) => entry.path)).toEqual(['.gitignore', 'src/.gitignore', 'src/keep.generated.ts', 'src/main.ts', 'src/root-only.txt']);
    expect(result.files.find((entry) => entry.path === 'src/main.ts')).toMatchObject({ absolutePath: path.join(root, 'src/main.ts'), size: 24, mtimeMs: expect.any(Number) });
    expect(result.truncated).toBe(false);
  });

  it('bounds file counts and per-file bytes and marks incomplete scans', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) file(name, 'small');
    expect(await collectProjectFiles(root, { maxFiles: 2 })).toMatchObject({ files: expect.any(Array), truncated: true });
    file('large.txt', 'longer than ten bytes');
    const result = await collectProjectFiles(root, { maxFileBytes: 10 });
    expect(result.files).toHaveLength(3);
    expect(result.files.map((entry) => entry.path)).not.toContain('large.txt');
    expect(result.truncated).toBe(true);
  });

  it('scopes file budgets to the requested subtree while retaining ancestor ignore rules', async () => {
    file('.gitignore', '*.generated.ts\n');
    file('unrelated/a.txt', 'unrelated');
    file('unrelated/b.txt', 'unrelated');
    file('src/skip.generated.ts', 'ignored');
    file('src/main.ts', 'kept');
    expect((await collectProjectFiles(root, { scope: 'src', maxFiles: 1 })).files.map((entry) => entry.path)).toEqual(['src/main.ts']);
  });

  it('honors cancellation before enumerating files', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by test'));
    await expect(collectProjectFiles(root, { signal: controller.signal })).rejects.toThrow('cancelled by test');
  });
});

describe('project grep and find', () => {
  beforeEach(() => {
    file('src/math.ts', 'export function sum(a: number, b: number) {\n  return a + b;\n}\n');
    file('src/math.test.ts', 'test("sum()", () => sum(1, 2));\n');
    file('scripts/build.js', 'console.log("building");\n');
    file('README.md', 'Welcome to the example project.\n');
  });

  it('finds file names with globstar, brace expansion and an optional directory scope', async () => {
    const result = await invoke('find', { pattern: '**/*.{ts,js}' });
    expect(text(result).split('\n')).toEqual(['scripts/build.js', 'src/math.test.ts', 'src/math.ts']);
    const scoped = await invoke('find', { pattern: '*.ts', path: 'src' });
    expect(text(scoped).split('\n')).toEqual(['src/math.test.ts', 'src/math.ts']);
  });

  it('uses a Node worker for regex searches and returns line locations and context', async () => {
    const result = await invoke('grep', { pattern: '^export\\s+function\\s+sum', glob: '**/*.ts', context: 1 });
    expect(result.details).toMatchObject({ backend: 'node', matches: 1, truncated: false });
    expect(text(result)).toContain('src/math.ts:1:export function sum');
    expect(text(result)).toContain('src/math.ts-2-  return a + b;');
  });

  it('supports literal, case-insensitive searches in a single file', async () => {
    const result = await invoke('grep', { pattern: 'SUM(', literal: true, ignoreCase: true, path: 'src/math.ts' });
    expect(result.details).toMatchObject({ backend: 'node', matches: 1, scannedFiles: 1 });
    expect(text(result)).toContain('src/math.ts:1:');
    expect(text(result)).not.toContain('math.test.ts');
  });

  it('does not return ignored ordinary files and skips binary data', async () => {
    file('.gitignore', 'ignored/\n');
    file('ignored/report.txt', 'unique_search_text');
    file('blob.bin', Buffer.from('unique_search_text\0binary'));
    expect(text(await invoke('grep', { pattern: 'unique_search_text', literal: true }))).toBe('No matches found.');
  });

  it('limits matches and find results with an explicit truncation notice', async () => {
    file('many.txt', 'target\ntarget\ntarget\n');
    const matches = await invoke('grep', { pattern: 'target', limit: 1 });
    expect(matches.details).toMatchObject({ matches: 1, truncated: true });
    expect(text(matches).match(/many.txt:/g)).toHaveLength(1);
    expect(text(matches)).toContain('截断');
    const found = await invoke('find', { pattern: '**/*.ts', limit: 1 });
    expect(found.details).toMatchObject({ resultLimitReached: 1, truncated: true });
  });

  it('falls back without downloading when the configured ripgrep binary is missing', async () => {
    const result = await invoke('grep', { pattern: 'export function', literal: true }, { rgPath: path.join(root, 'missing-rg') });
    expect(result.details).toMatchObject({ backend: 'node', matches: 1 });
  });

  it('runs ordinary searches with the bundled ripgrep when available', async (context) => {
    const binary = await locateRipgrep();
    if (!binary) { context.skip(); return; }
    const result = await invoke('grep', { pattern: 'sum(', literal: true, glob: '**/*.ts' }, { rgPath: binary });
    expect(result.details).toMatchObject({ backend: 'ripgrep', matches: 2, truncated: false });
    expect(text(result)).toContain('src/math.ts:1:');
    expect(text(result)).toContain('src/math.test.ts:1:');
  });

  it('rejects an invalid regex instead of returning an empty success', async () => {
    await expect(invoke('grep', { pattern: '[' })).rejects.toThrow();
  });

  it('honors cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by test'));
    await expect(invoke('grep', { pattern: 'sum' }, { rgPath: null }, controller.signal)).rejects.toThrow('cancelled by test');
  });
});
