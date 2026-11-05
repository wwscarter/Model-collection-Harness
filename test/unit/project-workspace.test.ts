import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectStorage } from '@core/storage/ProjectStorage';
import { inspectProject, readGitInfo } from '@core/project/ProjectInspector';

const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe('ProjectStorage', () => {
  it('upserts by root and keeps custom names and creation order', () => {
    const storage = new ProjectStorage(':memory:');
    const first = storage.recordOpened('/work/alpha', 'Alpha', new Date('2026-01-01T00:00:00Z'));
    storage.recordOpened('/work/beta', undefined, new Date('2026-01-02T00:00:00Z'));
    const reopened = storage.recordOpened('/work/alpha', undefined, new Date('2026-01-03T00:00:00Z'));
    expect(reopened.id).toBe(first.id);
    expect(reopened.name).toBe('Alpha');
    expect(reopened.createdAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(reopened.lastOpenedAt).toEqual(new Date('2026-01-03T00:00:00Z'));
    expect(storage.list().map((project) => project.name)).toEqual(['Alpha', 'beta']);
    expect(storage.recordOpened('/work/alpha', 'Renamed').name).toBe('Renamed');
    expect(storage.remove(first.id)).toBe(true);
    expect(storage.remove(first.id)).toBe(false);
    expect(storage.get(first.id)).toBeUndefined();
    expect(storage.list()).toHaveLength(1);
    storage.close();
  });

  it('keeps middle and last projects in place when they are reopened or renamed', () => {
    const storage = new ProjectStorage(':memory:');
    try {
      for (const [index, name] of ['Alpha', 'Beta', 'Gamma'].entries()) {
        storage.recordOpened('/work/' + name.toLowerCase(), name, new Date(`2026-01-0${index + 1}T00:00:00Z`));
      }
      const ids = storage.list().map((project) => project.id);
      storage.recordOpened('/work/beta', undefined, new Date('2026-02-01T00:00:00Z'));
      expect(storage.list().map((project) => project.id)).toEqual(ids);
      storage.recordOpened('/work/gamma', undefined, new Date('2026-02-02T00:00:00Z'));
      expect(storage.list().map((project) => project.id)).toEqual(ids);
      const renamed = storage.recordOpened('/work/beta', 'Beta renamed', new Date('2026-02-03T00:00:00Z'));
      expect(storage.list().map((project) => project.id)).toEqual(ids);
      expect(storage.list().map((project) => project.name)).toEqual(['Alpha', 'Beta renamed', 'Gamma']);
      expect(renamed.lastOpenedAt).toEqual(new Date('2026-02-03T00:00:00Z'));
      storage.recordOpened('/work/delta', 'Delta', new Date('2026-02-04T00:00:00Z'));
      expect(storage.list().map((project) => project.name)).toEqual(['Alpha', 'Beta renamed', 'Gamma', 'Delta']);
    } finally { storage.close(); }
  });

  it('preserves insertion order for equal creation times after closing and reopening the database', () => {
    const directory = tempDir('newai-project-order-');
    const database = path.join(directory, 'projects.db');
    let storage = new ProjectStorage(database);
    const created = new Date('2026-01-01T00:00:00Z');
    try {
      for (const name of ['Gamma', 'Alpha', 'Beta']) storage.recordOpened('/work/' + name.toLowerCase(), name, created);
      const original = storage.list();
      expect(original.map((project) => project.name)).toEqual(['Gamma', 'Alpha', 'Beta']);
      storage.recordOpened('/work/alpha', 'Alpha renamed', new Date('2026-03-01T00:00:00Z'));
      storage.recordOpened('/work/beta', undefined, new Date('2026-03-02T00:00:00Z'));
      storage.close();
      storage = new ProjectStorage(database);
      expect(storage.list().map((project) => project.id)).toEqual(original.map((project) => project.id));
      expect(storage.list().map((project) => project.name)).toEqual(['Gamma', 'Alpha renamed', 'Beta']);
      expect(storage.getByRoot('/work/alpha')?.createdAt).toEqual(created);
      expect(storage.getByRoot('/work/alpha')?.lastOpenedAt).toEqual(new Date('2026-03-01T00:00:00Z'));
    } finally { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('ProjectInspector', () => {
  it('detects the branch, languages and manifest files', () => {
    const root = tempDir('amd-inspect-');
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/login\n');
    for (const file of ['package.json', 'tsconfig.json', 'pyproject.toml']) fs.writeFileSync(path.join(root, file), '');
    const result = inspectProject(root);
    expect(result.root).toBe(fs.realpathSync(root));
    expect(result.suggestedName).toBe(path.basename(fs.realpathSync(root)));
    expect(result.git).toEqual({ branch: 'feature/login' });
    expect(result.languages).toEqual(['TypeScript', 'Python']);
    expect(result.markers).toEqual(['package.json', 'tsconfig.json', 'pyproject.toml']);
  });

  it('handles detached heads, worktree pointer files and plain folders', () => {
    const detached = tempDir('amd-detached-');
    fs.mkdirSync(path.join(detached, '.git'));
    fs.writeFileSync(path.join(detached, '.git', 'HEAD'), 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n');
    expect(readGitInfo(detached)).toEqual({ detached: true, head: 'a1b2c3d' });

    const worktree = tempDir('amd-worktree-');
    const gitDir = tempDir('amd-gitdir-');
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\r\n');
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\r\n`);
    expect(readGitInfo(worktree)).toEqual({ branch: 'main' });

    const plain = tempDir('amd-plain-');
    expect(readGitInfo(plain)).toBeUndefined();
    expect(inspectProject(plain)).toMatchObject({ languages: [], markers: [] });
    expect(() => inspectProject(path.join(plain, 'missing'))).toThrow();
  });
});
