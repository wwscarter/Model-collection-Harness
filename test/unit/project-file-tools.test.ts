import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileTools } from '../../src/core/tools/builtinTools';

let projectRoot = '';

beforeEach(() => { projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-project-tools-')); });
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

function execute(name: string, input: Record<string, unknown>) {
  const tool = createFileTools({ cwd: projectRoot, projectRoot }).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.execute(`test-${name}`, input, undefined, undefined, { cwd: projectRoot } as never);
}

describe('project file tools', () => {
  it('registers mutation tools only for a selected project', () => {
    expect(createFileTools({ cwd: projectRoot }).map((tool) => tool.name)).toEqual(['read']);
    expect(createFileTools({ cwd: projectRoot, projectRoot }).map((tool) => tool.name)).toEqual(['read', 'ls', 'write', 'edit', 'grep', 'find']);
  });

  it('creates nested directories and writes UTF-8 webpage content', async () => {
    const content = '<!doctype html>\n<h1>你好，newAi 🌏</h1>\n';
    const result = await execute('write', { path: 'website/pages/index.html', content });
    expect(fs.readFileSync(path.join(projectRoot, 'website/pages/index.html'), 'utf8')).toBe(content);
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('Successfully wrote') })]));
  });

  it('overwrites an existing file when a complete rewrite is requested', async () => {
    fs.writeFileSync(path.join(projectRoot, 'index.html'), '<h1>First draft</h1>');
    await execute('write', { path: 'index.html', content: '<h1>完成</h1>' });
    expect(fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8')).toBe('<h1>完成</h1>');
  });

  it('edits existing text and returns a useful patch', async () => {
    fs.writeFileSync(path.join(projectRoot, 'index.html'), '<title>Draft</title>\n<h1>你好</h1>\n');
    const result = await execute('edit', { path: 'index.html', edits: [{ oldText: '<title>Draft</title>', newText: '<title>NewAi Site</title>' }, { oldText: '<h1>你好</h1>', newText: '<h1>欢迎访问</h1>' }] });
    expect(fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8')).toBe('<title>NewAi Site</title>\n<h1>欢迎访问</h1>\n');
    expect(result.details).toMatchObject({ patch: expect.stringContaining('+<title>NewAi Site</title>'), firstChangedLine: 1 });
  });

  it('reports a missing file instead of creating one during edit', async () => {
    await expect(execute('edit', { path: 'missing.html', edits: [{ oldText: 'Draft', newText: 'Site' }] })).rejects.toThrow('ENOENT');
    expect(fs.existsSync(path.join(projectRoot, 'missing.html'))).toBe(false);
  });

  it('leaves a file intact when the requested original text is absent', async () => {
    fs.writeFileSync(path.join(projectRoot, 'index.html'), '<h1>Original</h1>');
    await expect(execute('edit', { path: 'index.html', edits: [{ oldText: '<h1>Other</h1>', newText: '<h1>Updated</h1>' }] })).rejects.toThrow();
    expect(fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8')).toBe('<h1>Original</h1>');
  });
});
