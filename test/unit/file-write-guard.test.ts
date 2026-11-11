import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileTools } from '../../src/core/tools/builtinTools';
import { FileWriteGuard } from '../../src/core/tools/fileWriteGuard';

let projectRoot = '';
let guard: FileWriteGuard;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-write-guard-'));
  guard = new FileWriteGuard();
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

function execute(name: string, input: Record<string, unknown>) {
  const tool = createFileTools({ cwd: projectRoot, projectRoot, writeGuard: guard }).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.execute(`call-${name}`, input, undefined, undefined, { cwd: projectRoot } as never);
}

const write = (file: string, content: string) => execute('write', { path: file, content });
const read = (file: string) => execute('read', { path: file });
const edit = (file: string, oldText: string, newText: string) => execute('edit', { path: file, edits: [{ oldText, newText }] });

describe('FileWriteGuard', () => {
  it('blocks a full overwrite when the file changed after the agent read it', async () => {
    fs.writeFileSync(path.join(projectRoot, 'config.json'), '{"version":1}');
    await read('config.json');
    // The user (or a formatter) edits the file between the agent's read and write.
    fs.writeFileSync(path.join(projectRoot, 'config.json'), '{"version":2,"comment":"user edit"}');

    await expect(write('config.json', '{"version":1,"generated":true}')).rejects.toThrow('已被外部修改');
    await expect(write('config.json', '{"version":1,"generated":true}')).rejects.toThrow('重新 read');
    expect(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8')).toBe('{"version":2,"comment":"user edit"}');
  });

  it('allows the write again after the agent re-read the current content', async () => {
    fs.writeFileSync(path.join(projectRoot, 'notes.md'), 'first');
    await read('notes.md');
    fs.writeFileSync(path.join(projectRoot, 'notes.md'), 'second (external)');

    await expect(write('notes.md', 'third')).rejects.toThrow('已被外部修改');
    await read('notes.md');
    await write('notes.md', 'third');
    expect(fs.readFileSync(path.join(projectRoot, 'notes.md'), 'utf8')).toBe('third');
  });

  it('does not block the agent\'s own consecutive writes', async () => {
    await write('README.md', 'one');
    await write('README.md', 'two');
    await write('README.md', 'three');
    expect(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8')).toBe('three');
  });

  it('still lets the agent create new files and rewrite files it never read', async () => {
    await write('src/new-file.ts', 'export const value = 1;\n');
    fs.writeFileSync(path.join(projectRoot, 'generated.txt'), 'existing content');
    await write('generated.txt', 'deliberate complete rewrite');
    expect(fs.readFileSync(path.join(projectRoot, 'src/new-file.ts'), 'utf8')).toBe('export const value = 1;\n');
    expect(fs.readFileSync(path.join(projectRoot, 'generated.txt'), 'utf8')).toBe('deliberate complete rewrite');
  });

  it('keeps edit working after a read and applies it to the latest content', async () => {
    fs.writeFileSync(path.join(projectRoot, 'page.html'), '<h1>Draft</h1>\n');
    await read('page.html');
    await edit('page.html', '<h1>Draft</h1>', '<h1>Welcome</h1>');
    expect(fs.readFileSync(path.join(projectRoot, 'page.html'), 'utf8')).toBe('<h1>Welcome</h1>\n');
  });

  it('treats a file deleted after the read as writable again', async () => {
    const target = path.join(projectRoot, 'temporary.txt');
    fs.writeFileSync(target, 'data');
    await read('temporary.txt');
    fs.rmSync(target);
    await write('temporary.txt', 'recreated');
    expect(fs.readFileSync(target, 'utf8')).toBe('recreated');
  });

  it('ignores files the guard has never seen and bounds its tracking', async () => {
    await expect(guard.assertUnchangedSinceRead(path.join(projectRoot, 'unknown.txt'))).resolves.toBeUndefined();
    for (let index = 0; index < 2_500; index += 1) guard.record(path.join(projectRoot, `file-${index}.txt`), String(index));
    // The oldest 500 entries were evicted; the newest ones are still tracked.
    expect(guard.tracks(path.join(projectRoot, 'file-2499.txt'))).toBe(true);
    expect(guard.tracks(path.join(projectRoot, 'file-0.txt'))).toBe(false);
  });
});
