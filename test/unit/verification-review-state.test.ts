import { describe, expect, it, vi } from 'vitest';
import { VerificationLoop, type ProjectVerifyConfig } from '../../src/core/verify/VerificationLoop';

// Isolated synthetic check results exercise loop state; real compiler/session
// behavior is covered separately in agent-runtime-verification.test.ts.
function config(maxRepairRounds = 2): ProjectVerifyConfig {
  return { version: 1, mode: 'quick', timeoutMs: 1_000, maxRepairRounds, commands: [{ id: 'types', label: 'types', command: 'synthetic type check', phase: 'quick' }], manifestFingerprint: 'a'.repeat(64), confirmedAt: new Date().toISOString() };
}

describe('review-driven verification state', () => {
  it('retains check attempts and shares the original repair allowance with model review', async () => {
    let calls = 0;
    const execute = vi.fn(async () => ({ exitCode: calls++ === 0 ? 1 : 0, output: '', durationMs: 1 }));
    const loop = new VerificationLoop({ projectRoot: process.cwd(), getConfig: async () => config(), execute });
    expect(await loop.afterTurn({ content: 'Initial answer' }, ['sum.ts'])).toHaveProperty('feedback');
    await loop.afterTurn({ content: 'Compiler fix' }, ['sum.ts']);
    expect(loop.outcome).toMatchObject({ status: 'passed', repairRounds: 1 });
    expect(loop.resumeAfterReview('Use tools to correct the ordinary logic issue.')).toHaveProperty('feedback');
    expect(loop.outcome).toMatchObject({ repairRounds: 2 });
    await loop.afterTurn({ content: 'Actual file repaired' }, ['sum.ts']);
    expect(loop.outcome?.attempts.map((attempt) => attempt.round)).toEqual([0, 1, 2]);
    expect(loop.outcome?.repairRounds).toBe(2);
    expect(loop.resumeAfterReview('Another requested repair.').feedback).toBeUndefined();
    expect(loop.outcome).toMatchObject({ status: 'failed', repairRounds: 2 });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('does not reopen passed checks when automatic repair is disabled', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: '', durationMs: 1 }));
    const loop = new VerificationLoop({ projectRoot: process.cwd(), getConfig: async () => config(0), execute });
    await loop.afterTurn({ content: 'Initial answer' }, ['sum.ts']);
    const result = loop.resumeAfterReview('A review issue requires a real file change.');
    expect(result.feedback).toBeUndefined();
    expect(result.summary).toContain('修复额度已用尽');
    expect(loop.outcome).toMatchObject({ status: 'failed', repairRounds: 0 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('retains successful check records when the independent review remains unresolved', async () => {
    const loop = new VerificationLoop({ projectRoot: process.cwd(), getConfig: async () => config(), execute: async () => ({ exitCode: 0, output: '', durationMs: 1 }) });
    expect(() => loop.resumeAfterReview('Not checked yet')).toThrow('检查通过后');
    await loop.afterTurn({ content: 'Initial answer' }, ['sum.ts']);
    loop.endReview('failed', '模型复核未通过：普通逻辑问题尚未解决。');
    expect(loop.outcome).toMatchObject({ status: 'failed', attempts: [{ status: 'passed', commands: [{ result: { exitCode: 0 } }] }] });
    expect(loop.outcome?.summary).not.toContain('验证通过');
  });

  it('classifies a runtime TimeoutError as unverified while propagating the original deadline', async () => {
    const controller = new AbortController();
    const timeout = new Error('Synthetic session deadline');
    timeout.name = 'TimeoutError';
    const loop = new VerificationLoop({ projectRoot: process.cwd(), getConfig: async () => config(), execute: async () => { controller.abort(timeout); return new Promise(() => undefined); } });
    await expect(loop.afterTurn({ content: 'Initial answer' }, ['sum.ts'], controller.signal)).rejects.toBe(timeout);
    expect(loop.outcome).toMatchObject({ status: 'unverified', attempts: [{ commands: [{ result: { timedOut: true, cancelled: false } }] }] });
    expect(loop.outcome?.summary).toContain('会话超时');
  });
});
