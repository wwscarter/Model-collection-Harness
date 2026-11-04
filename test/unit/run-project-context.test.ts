import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectManager } from '../../src/core/project/ProjectManager';
import { createRunProjectContext } from '../../src/core/project/RunProjectContext';
import { ProjectStorage } from '../../src/core/storage/ProjectStorage';

let directory: string;
let storage: ProjectStorage;
let rootA: string;
let rootB: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-run-project-'));
  rootA = path.join(directory, 'project-a');
  rootB = path.join(directory, 'project-b');
  fs.mkdirSync(rootA);
  fs.mkdirSync(rootB);
  rootA = fs.realpathSync(rootA);
  rootB = fs.realpathSync(rootB);
  fs.writeFileSync(path.join(rootA, 'README.md'), 'Project A requirements');
  fs.writeFileSync(path.join(rootB, 'README.md'), 'Project B requirements');
  storage = new ProjectStorage(':memory:');
});

afterEach(() => {
  storage.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('run project context', () => {
  it.each([null, undefined])('keeps an unassociated conversation empty when the file panel has a project (%s)', async (projectId) => {
    const panel = new ProjectManager();
    panel.select(rootA);
    storage.recordOpened(rootA);

    const run = createRunProjectContext(projectId, storage);
    expect(run.getRoot()).toBeUndefined();
    expect(await run.getContextAsync()).toBeUndefined();
    expect(panel.getRoot()).toBe(rootA);
  });

  it('uses the conversation project and keeps it when the file panel switches projects', async () => {
    const projectA = storage.recordOpened(rootA);
    const projectB = storage.recordOpened(rootB);
    const panel = new ProjectManager();
    panel.select(rootB);

    const runA = createRunProjectContext(projectA.id, storage);
    panel.select(rootA);
    const runB = createRunProjectContext(projectB.id, storage);
    panel.clear();

    const [contextA, contextB] = await Promise.all([runA.getContextAsync(), runB.getContextAsync()]);
    expect(runA.getRoot()).toBe(rootA);
    expect(contextA?.text).toContain('Project A requirements');
    expect(contextA?.text).not.toContain('Project B requirements');
    expect(runB.getRoot()).toBe(rootB);
    expect(contextB?.text).toContain('Project B requirements');
    expect(panel.getRoot()).toBeUndefined();
  });

  it('reports a removed association without changing an already captured run', async () => {
    const project = storage.recordOpened(rootA);
    const run = createRunProjectContext(project.id, storage);
    storage.remove(project.id);

    expect(() => createRunProjectContext(project.id, storage)).toThrow('会话关联的项目已被移除');
    expect((await run.getContextAsync())?.text).toContain('Project A requirements');
  });
});
