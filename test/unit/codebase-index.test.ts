import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodebaseIndex } from '../../src/core/codebase/CodebaseIndex';

const fixtures: Array<{ directory: string; index: CodebaseIndex }> = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) { fixture.index.dispose(); fs.rmSync(fixture.directory, { recursive: true, force: true }); } });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-code-index-'));
  const project = path.join(directory, 'project');
  const dataDir = path.join(directory, 'data');
  fs.mkdirSync(project);
  const index = new CodebaseIndex(dataDir);
  fixtures.push({ directory, index });
  return { index, directory, project, dataDir };
}

describe('local background codebase index', () => {
  it('persists declarations in a project-specific SQLite FTS index and filters by kind', async () => {
    const { index, project, dataDir } = fixture();
    fs.writeFileSync(path.join(project, 'greeter.ts'), 'export interface Greeter {}\nexport function greetPerson() {}\nfunction localGreet() {}');
    fs.writeFileSync(path.join(project, 'README.md'), 'A plain project document.');
    const stats = await index.refresh(project);
    expect(stats).toMatchObject({ files: 1, indexed: 1, unchanged: 0, removed: 0, symbols: 3, truncated: false, errors: [] });
    expect(await index.symbols(project, 'greet')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'greetPerson', path: 'greeter.ts', line: 2 })]));
    expect(await index.symbols(project, 'Greeter', 'interface')).toMatchObject([{ name: 'Greeter', kind: 'interface' }]);
    expect((await index.symbols(project, '', 'export')).map((symbol) => symbol.name)).toEqual(['Greeter', 'greetPerson']);
    expect(await index.symbols(project, '', undefined, 1)).toHaveLength(1);
    const root = fs.realpathSync(project);
    expect(fs.existsSync(path.join(dataDir, 'index', createHash('sha1').update(root).digest('hex') + '.db'))).toBe(true);
    const reopened = new CodebaseIndex(dataDir);
    try { expect(await reopened.symbols(project, 'greetPerson')).toMatchObject([{ name: 'greetPerson' }]); }
    finally { reopened.dispose(); }
  });

  it('updates only changed files and removes old declarations after rename or deletion', async () => {
    const { index, project } = fixture();
    fs.writeFileSync(path.join(project, 'first.ts'), 'export function firstName() {}');
    fs.writeFileSync(path.join(project, 'stable.py'), 'def stable_name():\n    pass\n');
    await index.refresh(project);
    expect(await index.refresh(project)).toMatchObject({ indexed: 0, unchanged: 2, removed: 0 });
    fs.writeFileSync(path.join(project, 'first.ts'), 'export function updatedNameLonger() {}');
    expect(await index.refresh(project, ['first.ts'])).toMatchObject({ indexed: 1, unchanged: 0, removed: 0, symbols: 2 });
    expect(await index.symbols(project, 'firstName')).toEqual([]);
    expect(await index.symbols(project, 'updatedName')).toMatchObject([{ name: 'updatedNameLonger' }]);
    fs.renameSync(path.join(project, 'first.ts'), path.join(project, 'renamed.ts'));
    expect(await index.refresh(project)).toMatchObject({ indexed: 1, unchanged: 1, removed: 1 });
    expect(await index.symbols(project, 'updatedName')).toMatchObject([{ path: 'renamed.ts' }]);
    fs.rmSync(path.join(project, 'renamed.ts'));
    expect(await index.refresh(project, ['renamed.ts'])).toMatchObject({ indexed: 0, removed: 1, symbols: 1 });
    expect(await index.symbols(project, 'updatedName')).toEqual([]);
  });

  it('respects ordinary gitignore rules and updates the index when they change', async () => {
    const { index, project } = fixture();
    fs.writeFileSync(path.join(project, '.gitignore'), 'generated.ts\n');
    fs.writeFileSync(path.join(project, 'source.ts'), 'export class Source {}');
    fs.writeFileSync(path.join(project, 'generated.ts'), 'export class Generated {}');
    expect(await index.refresh(project)).toMatchObject({ indexed: 1, symbols: 1 });
    expect(await index.symbols(project, 'Generated')).toEqual([]);
    fs.writeFileSync(path.join(project, '.gitignore'), 'source.ts\n');
    expect(await index.refresh(project)).toMatchObject({ indexed: 1, removed: 1, symbols: 1 });
    expect(await index.symbols(project, 'Source')).toEqual([]);
    expect(await index.symbols(project, 'Generated')).toMatchObject([{ name: 'Generated' }]);
  });

  it('serializes concurrent refreshes and honors cancellation before starting', async () => {
    const { index, project } = fixture();
    fs.writeFileSync(path.join(project, 'example.rs'), 'pub fn example() {}');
    const results = await Promise.all([index.refresh(project), index.refresh(project)]);
    expect(results.map((stats) => stats.indexed)).toEqual([1, 0]);
    const controller = new AbortController();
    controller.abort(new Error('cancel ordinary indexing'));
    await expect(index.refresh(project, undefined, controller.signal)).rejects.toThrow('cancel ordinary indexing');
    expect(await index.symbols(project, 'example')).toMatchObject([{ name: 'example', language: 'rust' }]);
  });
});
