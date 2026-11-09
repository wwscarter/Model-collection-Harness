import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeReport } from '../../eval/runner/report';
import type { EvalSample } from '../../eval/runner/types';

const directories: string[] = [];
const directory = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-eval-report-')); directories.push(root); return root; };
const sample = (passed = true, iteration = 1): EvalSample => ({ taskId: 'ordinary-task', tags: ['code'], model: 'custom/actual-model (environment-model)', modelSnapshot: { configId: 'environment-model', provider: 'custom', modelId: 'actual-model' }, mode: 'model', iteration, passed, durationMs: 100, toolCalls: 2, cost: null, inputTokens: 10, outputTokens: 4, checks: [] });
afterEach(() => { for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('evaluation report outcomes', () => {
  it('records an interrupted batch identically in JSON and Markdown even when completed samples passed', () => {
    const report = writeReport([sample()], directory(), 'model', undefined, { cancelled: true, expectedSamples: 4 });
    expect(report).toMatchObject({ passed: false, cancelled: true, expectedSamples: 4, summary: { runs: 1, passed: 1 } });
    expect(JSON.parse(fs.readFileSync(report.jsonPath, 'utf8'))).toMatchObject({ passed: false, cancelled: true, expectedSamples: 4 });
    const markdown = fs.readFileSync(report.markdownPath, 'utf8');
    expect(markdown).toContain('Status: **Cancelled**');
    expect(markdown).toContain('Completed samples: 1/4');
    expect(markdown).toContain('completed results are retained');
    expect(markdown).toContain('## By model');
    expect(markdown).toContain('custom/actual-model (environment-model)');
    expect(markdown).toContain('Unknown');
    expect(markdown).not.toContain('N/A (smoke)');
  });

  it('requires every expected sample to complete before marking a batch passed', () => {
    expect(writeReport([sample()], directory(), 'model', undefined, { expectedSamples: 2 }).passed).toBe(false);
    const complete = writeReport([sample()], directory(), 'model');
    expect(complete).toMatchObject({ passed: true, cancelled: false, expectedSamples: 1 });
    expect(fs.readFileSync(complete.markdownPath, 'utf8')).toContain('Status: **Passed**');
  });

  it('keeps an already flaky baseline task out of newly introduced failures', () => {
    const baseline = writeReport([sample(true, 1), sample(false, 2)], directory(), 'model');
    const current = writeReport([sample(false)], directory(), 'model', baseline.jsonPath);
    expect(current.regressions).toEqual([]);
  });
});
