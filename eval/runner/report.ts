import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EvalGroup, EvalReport, EvalSample } from './types';
export function summarize(samples: EvalSample[]): EvalGroup {
  const runs = samples.length; const passed = samples.filter((sample) => sample.passed).length;
  const statuses = samples.map((sample) => sample.verification?.status ?? 'not-run');
  const count = (...values: string[]) => statuses.filter((status) => values.includes(status)).length;
  const skipped = count('skipped'); const notRun = count('not-run');
  const attempted = runs - skipped - notRun; const verified = count('passed');
  const verification = { attempted, passed: verified, failed: count('failed'), unverified: count('unverified', 'cancelled', 'budget_limit'), skipped, notRun, passRate: attempted ? verified / attempted : null };
  return { runs, passed, passRate: runs ? passed / runs : 0, meanDurationMs: runs ? samples.reduce((sum, sample) => sum + sample.durationMs, 0) / runs : 0, meanToolCalls: runs ? samples.reduce((sum, sample) => sum + sample.toolCalls, 0) / runs : 0, meanCost: runs && samples.every((sample) => sample.cost !== null) ? samples.reduce((sum, sample) => sum + sample.cost!, 0) / runs : null, verification };
}
export function writeReport(samples: EvalSample[], resultsDir: string, mode: EvalReport['mode'], baseline?: string, options: { cancelled?: boolean; expectedSamples?: number } = {}): EvalReport {
  const expectedSamples = options.expectedSamples ?? samples.length;
  if (!Number.isSafeInteger(expectedSamples) || expectedSamples < samples.length) throw new Error('Expected sample count must be an integer at least as large as the completed sample count');
  const cancelled = options.cancelled === true;
  const byTag: Record<string, EvalGroup> = {}; const byModel: Record<string, EvalGroup> = {};
  for (const tag of new Set(samples.flatMap((sample) => sample.tags))) byTag[tag] = summarize(samples.filter((sample) => sample.tags.includes(tag)));
  for (const model of new Set(samples.map((sample) => sample.model))) byModel[model] = summarize(samples.filter((sample) => sample.model === model));
  let regressions: string[] = [];
  if (baseline) {
    const previous = JSON.parse(fs.readFileSync(baseline, 'utf8')) as EvalReport;
    if (previous.schemaVersion !== 1 || previous.mode !== mode || !Array.isArray(previous.samples)) throw new Error('Baseline must use the same report schema and smoke/model mode');
    const priorFailures = new Set(previous.samples.filter((sample) => !sample.passed).map((sample) => sample.taskId + ':' + sample.model));
    const good = new Set(previous.samples.filter((sample) => sample.passed && !priorFailures.has(sample.taskId + ':' + sample.model)).map((sample) => sample.taskId + ':' + sample.model));
    regressions = [...new Set(samples.filter((sample) => !sample.passed && good.has(sample.taskId + ':' + sample.model)).map((sample) => sample.taskId))];
  }
  fs.mkdirSync(resultsDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const stem = createdAt.replace(/[:.]/g, '-') + '-' + mode + '-' + randomUUID().slice(0, 6);
  const report: EvalReport = { schemaVersion: 1, createdAt, mode, cancelled, expectedSamples, passed: !cancelled && samples.length > 0 && samples.length === expectedSamples && samples.every((sample) => sample.passed), samples, summary: summarize(samples), byTag, byModel, regressions, jsonPath: path.resolve(resultsDir, stem + '.json'), markdownPath: path.resolve(resultsDir, stem + '.md') };
  const cell = (value: string) => value.replaceAll('|', String.fromCharCode(92) + '|').replace(/[\r\n]/g, ' ');
  const unknownCost = mode === 'smoke' ? 'N/A (smoke)' : 'Unknown';
  const row = (values: unknown[]) => '| ' + values.map((value) => cell(String(value))).join(' | ') + ' |';
  const grouped = (heading: string, label: string, groups: Record<string, EvalGroup>) => [
    '## ' + heading, '', '| ' + label + ' | Passed | Rate | Mean time (ms) | Mean tools | Mean cost | Project verification |',
    '|---|---:|---:|---:|---:|---:|---|',
    ...Object.entries(groups).map(([name, group]) => row([name, group.passed + '/' + group.runs, (100 * group.passRate).toFixed(1) + '%', Math.round(group.meanDurationMs), group.meanToolCalls.toFixed(1), group.meanCost ?? unknownCost, group.verification.attempted ? group.verification.passed + '/' + group.verification.attempted : 'Not run'])), '',
  ];
  const lines = [
    '# Evaluation report', '',
    'Mode: ' + (mode === 'smoke' ? '**Synthetic framework smoke — not model quality or cost measurements.**' : 'Real model evaluation'), '',
    'Created: ' + createdAt, '',
    'Status: **' + (cancelled ? 'Cancelled' : report.passed ? 'Passed' : 'Failed') + '**', '',
    'Completed samples: ' + samples.length + '/' + expectedSamples, '',
    ...(cancelled ? ['Evaluation was cancelled; completed results are retained and the overall run did not pass.', ''] : []),
    'Passed: ' + report.summary.passed + '/' + report.summary.runs, '',
    'Project verification: ' + report.summary.verification.passed + '/' + report.summary.verification.attempted + ' attempted; rate=' + (report.summary.verification.passRate === null ? 'N/A' : (100 * report.summary.verification.passRate).toFixed(1) + '%') + '; not run=' + report.summary.verification.notRun + '; skipped=' + report.summary.verification.skipped, '',
    '| Task | Model | Iteration | Passed | Tools | Duration (ms) | Cost | Verification |', '|---|---|---:|---|---:|---:|---:|---|',
    ...samples.map((sample) => row([sample.taskId, sample.model, sample.iteration, sample.passed ? 'yes' : 'no', sample.toolCalls, sample.durationMs, sample.cost ?? unknownCost, sample.verification?.status ?? 'not-run'])), '',
    ...grouped('By tag', 'Tag', byTag), ...grouped('By model', 'Model', byModel),
    'New failures: ' + (regressions.join(', ') || 'none'), '',
  ];
  for (const sample of samples.filter((value) => !value.passed)) lines.push('## ' + sample.taskId + ' / ' + sample.iteration, '', sample.error ?? '', ...sample.checks.filter((check) => !check.passed).map((check) => '- ' + check.type + ': ' + check.detail), '');
  fs.writeFileSync(report.jsonPath, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(report.markdownPath, lines.join('\n'));
  return report;
}
