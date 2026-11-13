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
  it('refreshes nested rules and preserves per-directory negation in previews and prompts', async () => {
    const root = fixture();
    try {
      const context = new ProjectContext(root);
      const rules = path.join(root, 'src', '.gitignore');
      fs.writeFileSync(rules, '*.txt\n!include.txt\n');
      fs.writeFileSync(path.join(root, 'src', 'include.txt'), 'include');
      fs.writeFileSync(path.join(root, 'src', 'omit.txt'), 'omit');
      for (const listings of [context.buildContext(), await context.buildContextAsync(), await context.buildContextAsync(['src/omit.txt', 'src/include.txt'])]) {
        expect(listings.files.map((item) => item.path)).toContain('src/include.txt');
        expect(listings.files.map((item) => item.path)).not.toContain('src/omit.txt');
      }
      expect(flatten(context.listTree('src')).map((node) => node.path)).not.toContain('src/omit.txt');
      expect(() => context.readTextFile('src/omit.txt')).toThrow('excluded');
      fs.writeFileSync(rules, '');
      expect(context.readTextFile('src/omit.txt').content).toBe('omit');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

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

  it('reads at most the configured per-file budget', async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'huge.txt'), 'x'.repeat(2_000_000));
    const context = new ProjectContext(root, { maxFileBytes: 1024 });
    const file = context.readTextFile('huge.txt');
    expect(file.content).toHaveLength(1024);
    expect(file.truncated).toBe(true);
    expect(file.size).toBe(2_000_000);
    const asyncFile = await context.buildContextAsync(['huge.txt'], 8000);
    expect(asyncFile.files[0]?.content).toHaveLength(1024);
    expect(asyncFile.files[0]?.truncated).toBe(true);
  });

  it('rejects traversal and binary files', () => {
    const root = fixture();
    const context = new ProjectContext(root);
    expect(() => context.readTextFile('../outside.txt')).toThrow(/inside/);
    expect(() => context.readTextFile('binary.bin')).toThrow(/Binary/);
  });

  it('never puts credential files in the project snapshot', async () => {
    const root = fixture();
    const secrets: Record<string, string> = {
      '.npmrc': '//registry.npmjs.org/:_authToken=npm_SECRET',
      '.netrc': 'machine example login user password netrc_SECRET',
      credentials: 'aws_secret_access_key=SECRET',
      'credentials.json': '{"token":"SECRET"}',
      '.env.test': 'TOKEN=SECRET',
      '.env.production.local': 'TOKEN=SECRET',
      'service-account-prod.json': '{"private_key":"SECRET"}',
      'cert.p12': 'binary',
      'src/app.ts': 'export const ok = true;\n',
    };
    for (const [name, content] of Object.entries(secrets)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content);
    }
    fs.mkdirSync(path.join(root, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aws', 'credentials'), 'aws_secret_access_key=SECRET');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://x-access-token:SECRET@github.com/a/b.git\n');

    const context = new ProjectContext(root);
    const sync = context.buildContext();
    const asyncResult = await context.buildContextAsync();
    for (const result of [sync, asyncResult]) {
      const paths = result.files.map((file) => file.path);
      expect(paths).toContain('src/app.ts');
      for (const name of ['.npmrc', '.netrc', 'credentials', 'credentials.json', '.env.test', '.env.production.local', 'service-account-prod.json', 'cert.p12', '.aws/credentials', '.git/config']) {
        expect(paths, name).not.toContain(name);
      }
      expect(result.text).not.toContain('SECRET');
    }
    expect(() => context.readTextFile('.npmrc')).toThrow(/excluded/);
  });
});

function flatten(node: ProjectNode): ProjectNode[] {
  return [node, ...(node.children ?? []).flatMap((child) => flatten(child))];
}
