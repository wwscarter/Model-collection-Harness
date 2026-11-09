import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runEval } from '../../eval/runner/runEval';
import { loadTasks, snapshotFiles } from '../../eval/runner/tasks';
import { runCheck } from '../../eval/runner/checks';
import { summarize, writeReport } from '../../eval/runner/report';
import type { EvalSample } from '../../eval/runner/types';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-eval-test-')); directories.push(root); return root; }
const sample = (taskId: string, passed: boolean): EvalSample => ({ taskId, tags: ['code'], model: 'synthetic-smoke', mode: 'smoke', iteration: 1, passed, durationMs: 10, toolCalls: 2, cost: null, inputTokens: null, outputTokens: null, checks: [] });

describe('offline evaluation runner', () => {
  it('loads twenty independent tasks and selects five explicit synthetic replays', () => {
    const tasks = loadTasks(path.resolve('eval/tasks'));
    expect(tasks).toHaveLength(20);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(20);
    expect(loadTasks(path.resolve('eval/tasks'), [], true)).toHaveLength(5);
    expect(loadTasks(path.resolve('eval/tasks'), ['http']).map((task) => task.id)).toEqual(['http-health']);
    for (const task of tasks) expect(snapshotFiles(task.fixture).size).toBeGreaterThan(0);
  });

  it('runs real tools against isolated fixture copies while labeling results as synthetic', async () => {
    const before = snapshotFiles(path.resolve('eval/tasks/sum-numbers/fixture'));
    const progress: string[] = [];
    const report = await runEval({ smoke: true, resultsDir: fixture(), onProgress: (event) => progress.push(event.type) });
    expect(report.samples.map((value) => ({ id: value.taskId, error: value.error, failed: value.checks.filter((check) => !check.passed) }))).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'sum-numbers', failed: [] })]));
    expect(report.passed, JSON.stringify(report.samples.filter((value) => !value.passed))).toBe(true);
    expect(report.summary).toMatchObject({ runs: 5, passed: 5, meanCost: null });
    expect(report.samples.every((value) => value.cost === null && value.inputTokens === null && value.outputTokens === null)).toBe(true);
    expect(report.samples.reduce((sum, value) => sum + value.toolCalls, 0)).toBeGreaterThan(5);
    expect(JSON.parse(fs.readFileSync(report.jsonPath, 'utf8')).mode).toBe('smoke');
    expect(fs.readFileSync(report.markdownPath, 'utf8')).toContain('not model quality or cost measurements');
    expect(progress.filter((value) => value === 'task-end')).toHaveLength(5);
    expect(snapshotFiles(path.resolve('eval/tasks/sum-numbers/fixture'))).toEqual(before);
  }, 60_000);

  it('checks command outcomes, preserved files, content, answer and usage independently', async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'notes.txt'), 'ordinary notes');
    const context = { projectRoot: root, original: snapshotFiles(root), answer: 'The result is ready.', toolCalls: 3, cost: 0.05, signal: new AbortController().signal, models: [], smoke: false };
    expect((await runCheck({ type: 'command', run: 'node --version', expectExit: 0 }, context)).passed).toBe(true);
    expect((await runCheck({ type: 'file-unchanged', path: 'notes.txt' }, context)).passed).toBe(true);
    expect((await runCheck({ type: 'file-contains', path: 'notes.txt', value: 'notes' }, context)).passed).toBe(true);
    expect((await runCheck({ type: 'answer-contains', value: 'ready' }, context)).passed).toBe(true);
    expect((await runCheck({ type: 'max-tool-calls', value: 2 }, context)).passed).toBe(false);
    expect((await runCheck({ type: 'max-cost', value: 0.1 }, context)).passed).toBe(true);
    fs.appendFileSync(path.join(root, 'notes.txt'), ' changed');
    expect((await runCheck({ type: 'file-unchanged', path: 'notes.txt' }, context)).passed).toBe(false);
  });

  it('writes group summaries and names newly failed tasks against a matching baseline', () => {
    const root = fixture();
    const previous = writeReport([sample('alpha', true), sample('beta', true)], root, 'smoke');
    const next = writeReport([sample('alpha', false), sample('beta', true)], path.join(root, 'next'), 'smoke', previous.jsonPath);
    expect(next.regressions).toEqual(['alpha']);
    expect(next.byTag.code.passRate).toBe(0.5);
    expect(next.byModel['synthetic-smoke'].runs).toBe(2);
    expect(summarize([])).toMatchObject({ runs: 0, passRate: 0, meanCost: null });
    expect(() => writeReport([], root, 'model', previous.jsonPath)).toThrow('same report schema');
  });

  it('returns a failed report without running tasks when cancelled before dispatch', async () => {
    const controller = new AbortController(); controller.abort();
    const report = await runEval({ smoke: true, signal: controller.signal, resultsDir: fixture() });
    expect(report.passed).toBe(false); expect(report.samples).toEqual([]);
  });

  it('explains an empty selection and invalid repetition rather than silently passing', async () => {
    expect(() => loadTasks(path.resolve('eval/tasks'), ['missing-tag'])).toThrow('No evaluation tasks');
    await expect(runEval({ smoke: true, repeat: 0 })).rejects.toThrow('between 1 and 20');
  });
});
