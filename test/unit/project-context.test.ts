import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectContext, type ProjectNode } from '@core/project/ProjectContext';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-project-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'hidden'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const answer = 42;\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret\n');
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'ignored\n');
  return root;
}

describe('ProjectContext', () => {
  it('lists a safe tree and ignores generated, secret and ignored files', () => {
    const root = fixture();
    const context = new ProjectContext(root);
    const tree = context.listTree();
    const paths = flatten(tree).map((node) => node.path);
    expect(paths).toContain('src/main.ts');
    expect(paths).toContain('README.md');
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('node_modules');
    expect(paths).not.toContain('ignored.txt');
    expect(paths).toContain('binary.bin');
  });

  it('builds bounded text context and reports truncation', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(500));
    const result = new ProjectContext(root, { maxContextTokens: 20 }).buildContext();
    expect(result.text).toContain('FILE:');
    expect(result.tokenCount).toBeLessThanOrEqual(20);
    expect(result.truncated).toBe(true);
  });

  it('rejects traversal and binary files', () => {
    const root = fixture();
    const context = new ProjectContext(root);
    expect(() => context.readTextFile('../outside.txt')).toThrow(/inside/);
    expect(() => context.readTextFile('binary.bin')).toThrow(/Binary/);
  });
});

function flatten(node: ProjectNode): ProjectNode[] {
  return [node, ...(node.children ?? []).flatMap((child) => flatten(child))];
}
