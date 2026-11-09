import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// All variants are isolated synthetic examples of ordinary arithmetic mistakes.
// They never alter the source fixture or represent production test results.
const fixture = path.dirname(fileURLToPath(import.meta.url));
const testFile = path.join('test', 'sum.test.mjs');
assert.ok(fs.existsSync(path.join(fixture, testFile)), 'Add test/sum.test.mjs before running this checker.');
const correct = fs.readFileSync(path.join(fixture, 'src', 'main.mjs'), 'utf8');
const cases = [
  ['correct implementation', correct, 0],
  ['synthetic off-by-one arithmetic', 'export function sum(values) { return values.reduce((total, value) => total + value, 0) + 1; }', 1],
  ['synthetic empty-array mistake', 'export function sum(values) { return values.length ? values.reduce((total, value) => total + value, 0) : null; }', 1],
  ['synthetic ignored negative values', 'export function sum(values) { return values.filter((value) => value >= 0).reduce((total, value) => total + value, 0); }', 1],
  ['synthetic single-element mistake', 'export function sum(values) { return values.length === 1 ? 0 : values.reduce((total, value) => total + value, 0); }', 1],
  ['synthetic discarded fractional parts', 'export function sum(values) { return values.reduce((total, value) => total + Math.trunc(value), 0); }', 1],
  ['synthetic input mutation', 'export function sum(values) { let total = 0; while (values.length) total += values.pop(); return total; }', 1],
];

for (const [label, source, expectedExit] of cases) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-synthetic-sum-tests-'));
  try {
    fs.mkdirSync(path.join(copy, 'src'));
    fs.writeFileSync(path.join(copy, 'src', 'main.mjs'), source);
    fs.copyFileSync(path.join(fixture, 'package.json'), path.join(copy, 'package.json'));
    fs.cpSync(path.join(fixture, 'test'), path.join(copy, 'test'), { recursive: true });
    const result = spawnSync(process.execPath, ['--test', testFile], { cwd: copy, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, label + ': the test process must finish normally.');
    assert.equal(result.status, expectedExit, label + ': expected exit ' + expectedExit + '.\n' + result.stdout + result.stderr);
    console.log(label + ': ' + (expectedExit === 0 ? 'tests passed' : 'tests detected the ordinary mistake'));
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
}
