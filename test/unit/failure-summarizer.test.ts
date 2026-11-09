import { describe, expect, it } from 'vitest';
import { failureOutputTail, summarizeFailure } from '@core/verify/FailureSummarizer';

describe('bounded local check failure summaries', () => {
  it.each([
    ['src/example.ts(12,3): error TS2322: ordinary type mismatch', 'src/example.ts', 12, 3],
    ['src/example.go:7:2: undefined: ordinaryName', 'src/example.go', 7, 2],
    ['error: ordinary Rust mismatch\n --> src/lib.rs:4:8', 'src/lib.rs', 4, 8],
    ['  File "tests/example.py", line 9, in ordinary_test\nValueError: ordinary mismatch', 'tests/example.py', 9, undefined],
    ['src/Example.java:[3,5] ordinary compilation error', 'src/Example.java', 3, 5],
  ])('extracts a location from ordinary compiler output', (output, file, line, column) => {
    expect(summarizeFailure(output).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ file, line, ...(column ? { column } : {}) })]));
  });
  it('keeps at most 4KB of UTF-8 output and removes terminal colour escapes', () => {
    const output = '普通输出\n'.repeat(2_000) + '\u001b[31merror: ordinary failure\u001b[0m';
    const tail = failureOutputTail(output);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(4_096);
    expect(tail).not.toContain('\u001b'); expect(tail.startsWith('\uFFFD')).toBe(false);
    expect(tail).toContain('error: ordinary failure');
  });
});
