import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError } from '@core/routing/RunBudget';
import { VerificationLoop, selectVerifyCommands, type ProjectVerifyConfig, type VerificationEvent, type VerificationLoopOptions, type VerifyCommand, type VerifyExecutionResult } from '@core/verify/VerificationLoop';

const lint: VerifyCommand = { id: 'lint', label: 'lint', command: 'npm run lint', phase: 'quick' };
const typecheck: VerifyCommand = { id: 'types', label: 'typecheck', command: 'npm run typecheck', phase: 'quick' };
const test: VerifyCommand = { id: 'test', label: 'test', command: 'npm run test', phase: 'full' };
const config = (overrides: Partial<ProjectVerifyConfig> = {}): ProjectVerifyConfig => ({ version: 1, mode: 'quick', timeoutMs: 120_000, maxRepairRounds: 2, commands: [lint, typecheck, test], manifestFingerprint: 'a'.repeat(64), confirmedAt: '2026-11-09T00:00:00Z', ...overrides });
const success = (): VerifyExecutionResult => ({ exitCode: 0, output: 'ordinary checks passed', durationMs: 20 });
const failed = (): VerifyExecutionResult => ({ exitCode: 1, output: 'src/example.ts(3,2): error TS2322: Type number is not assignable to string.', durationMs: 30 });
const turn = { content: 'Updated the ordinary example.', stopReason: 'stop' };
const changed = ['src/example.ts'];
function setup(overrides: Partial<VerificationLoopOptions> = {}) {
  const events: VerificationEvent[] = [];
  const execute = vi.fn<VerificationLoopOptions['execute']>(async () => success());
  const getConfig = vi.fn<VerificationLoopOptions['getConfig']>(async () => config());
  const loop = new VerificationLoop({ projectRoot: '/ordinary-fixture', execute, getConfig, onEvent: (event) => events.push(event), ...overrides });
  return { loop, events, execute, getConfig };
}
afterEach(() => { vi.useRealTimers(); });

describe('same-session project verification state machine', () => {
  it('passes quick checks once and records confirmed results and trace events', async () => {
    const { loop, execute, events, getConfig } = setup();
    const decision = await loop.afterTurn(turn, changed);
    expect(decision.feedback).toBeUndefined();
    expect(decision.summary).toContain('验证通过：lint ✓ typecheck ✓');
    expect(decision.summary).not.toContain('test ✓');
    expect(execute.mock.calls.map(([command]) => command.id)).toEqual(['lint', 'types']);
    expect(getConfig).toHaveBeenCalledWith(undefined, { changedFiles: changed });
    expect(loop.outcome).toMatchObject({ status: 'passed', repairRounds: 0, changedFiles: changed, attempts: [{ round: 0, status: 'passed' }] });
    expect(events.map((event) => event.type)).toEqual(['start', 'command-start', 'command-end', 'command-start', 'command-end', 'finish']);
  });

  it('requests a focused repair and verifies the subsequent turn', async () => {
    const { loop, execute, getConfig } = setup();
    execute.mockResolvedValueOnce(failed()).mockResolvedValueOnce(success());
    const first = await loop.afterTurn(turn, changed);
    expect(first.feedback).toContain('只修复这些失败');
    expect(first.feedback).toContain('src/example.ts(3,2)');
    expect(first.summary).toBeUndefined();
    const repaired = await loop.afterTurn({ ...turn, content: 'Repaired the ordinary type mismatch.' }, changed);
    expect(repaired.feedback).toBeUndefined();
    expect(repaired.summary).toContain('验证通过');
    expect(loop.outcome).toMatchObject({ status: 'passed', repairRounds: 1, attempts: [{ round: 0, status: 'failed' }, { round: 1, status: 'passed' }] });
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('stops after two repair rounds and preserves remaining errors honestly', async () => {
    const execute = vi.fn<VerificationLoopOptions['execute']>(async () => failed());
    const { loop } = setup({ execute, getConfig: async () => config({ commands: [typecheck] }) });
    expect((await loop.afterTurn(turn, changed)).feedback).toBeTruthy();
    expect((await loop.afterTurn(turn, changed)).feedback).toBeTruthy();
    const final = await loop.afterTurn(turn, changed);
    expect(final.feedback).toBeUndefined();
    expect(final.summary).toContain('验证未通过');
    expect(final.summary).toContain('src/example.ts:3');
    expect(loop.outcome).toMatchObject({ status: 'failed', repairRounds: 2 });
    expect(loop.outcome?.attempts).toHaveLength(3);
    await loop.afterTurn(turn, changed);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('honors zero allowed repair rounds', async () => {
    const { loop } = setup({ execute: async () => failed(), getConfig: async () => config({ commands: [typecheck], maxRepairRounds: 0 }) });
    const decision = await loop.afterTurn(turn, changed);
    expect(decision.feedback).toBeUndefined();
    expect(loop.outcome).toMatchObject({ status: 'failed', repairRounds: 0 });
  });

  it.each(['src/example.test.ts', 'tests/example.py', 'src/example_test.go', 'test_example.py'])('includes tests when %s changed', async (file) => {
    const { loop, execute } = setup();
    await loop.afterTurn(turn, [file]);
    expect(execute.mock.calls.map(([command]) => command.id)).toEqual(['lint', 'types', 'test']);
  });

  it('runs complete checks when full mode is selected', async () => {
    const { loop, execute } = setup({ getConfig: async () => config({ mode: 'full' }) });
    await loop.afterTurn(turn, changed);
    expect(execute.mock.calls.map(([command]) => command.id)).toEqual(['lint', 'types', 'test']);
  });

  it('checks project-relative test paths without treating a parent directory named test as a test file', async () => {
    const first = setup({ projectRoot: '/ordinary/test/project' });
    await first.loop.afterTurn(turn, ['/ordinary/test/project/src/example.ts']);
    expect(first.execute.mock.calls.map(([command]) => command.id)).toEqual(['lint', 'types']);
    const second = setup({ projectRoot: '/ordinary/test/project' });
    await second.loop.afterTurn(turn, ['/ordinary/test/project/tests/example.ts']);
    expect(second.execute.mock.calls.map(([command]) => command.id)).toEqual(['lint', 'types', 'test']);
  });

  it('does not run checks without successful file changes', async () => {
    const { loop, execute, getConfig } = setup();
    expect(await loop.afterTurn(turn, [])).toEqual({});
    expect(loop.outcome?.status).toBe('skipped');
    expect(execute).not.toHaveBeenCalled(); expect(getConfig).not.toHaveBeenCalled();
  });

  it('does not execute unconfirmed commands and respects disabled verification', async () => {
    const unconfirmed = setup({ getConfig: async () => undefined });
    expect((await unconfirmed.loop.afterTurn(turn, changed)).summary).toContain('尚未确认');
    expect(unconfirmed.loop.outcome?.status).toBe('unverified'); expect(unconfirmed.execute).not.toHaveBeenCalled();
    const disabled = setup({ getConfig: async () => config({ mode: 'off' }) });
    expect(await disabled.loop.afterTurn(turn, changed)).toEqual({});
    expect(disabled.loop.outcome?.status).toBe('skipped'); expect(disabled.execute).not.toHaveBeenCalled();
  });

  it('reports quick mode with no applicable commands as unverified', async () => {
    const { loop, execute } = setup({ getConfig: async () => config({ commands: [test] }) });
    expect((await loop.afterTurn(turn, changed)).summary).toContain('快速模式没有可用检查命令');
    expect(loop.outcome?.status).toBe('unverified'); expect(execute).not.toHaveBeenCalled();
  });

  it('shares exact command selection with the host before user confirmation', () => {
    expect(selectVerifyCommands([test], 'quick', '/ordinary/test/project', ['/ordinary/test/project/src/example.ts'])).toEqual([]);
    expect(selectVerifyCommands([test], 'quick', '/ordinary/test/project', ['/ordinary/test/project/tests/example.ts'])).toEqual([test]);
    expect(selectVerifyCommands([lint, test], 'off', '/ordinary/project', ['tests/example.ts'])).toEqual([]);
    expect(selectVerifyCommands([test, lint], 'full', '/ordinary/project', changed)).toEqual([lint, test]);
  });

  it('preserves the host reason when confirmed configuration is unavailable', async () => {
    const { loop, execute } = setup({ getConfig: async () => ({ unavailable: '来源清单已变化，需要重新确认检查命令' }) });
    expect((await loop.afterTurn(turn, changed)).summary).toContain('来源清单已变化');
    expect(loop.outcome).toMatchObject({ status: 'unverified', reason: '来源清单已变化，需要重新确认检查命令' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['tool_limit', 'budget_limit', 'length'])('does not start checks after %s', async (stopReason) => {
    const { loop, execute, getConfig } = setup();
    const result = await loop.afterTurn({ ...turn, stopReason }, changed);
    expect(result.feedback).toBeUndefined();
    expect(loop.outcome?.status).toBe(stopReason === 'budget_limit' ? 'budget_limit' : 'unverified');
    expect(execute).not.toHaveBeenCalled(); expect(getConfig).not.toHaveBeenCalled();
  });

  it('stops before commands when the shared run budget is exhausted', async () => {
    const { loop, execute, getConfig } = setup({ assertBudget: () => { throw new BudgetExceededError('ordinary exhausted budget'); } });
    expect((await loop.afterTurn(turn, changed)).summary).toContain('预算不足');
    expect(loop.outcome?.status).toBe('budget_limit');
    expect(execute).not.toHaveBeenCalled(); expect(getConfig).not.toHaveBeenCalled();
  });

  it('stops a pending repair when the shared budget is exhausted', async () => {
    let exhausted = false;
    const execute = vi.fn<VerificationLoopOptions['execute']>(async () => failed());
    const { loop } = setup({ execute, getConfig: async () => config({ commands: [typecheck] }), assertBudget: () => { if (exhausted) throw new BudgetExceededError('ordinary exhausted budget'); } });
    expect((await loop.afterTurn(turn, changed)).feedback).toBeTruthy();
    exhausted = true;
    expect((await loop.afterTurn(turn, changed)).summary).toContain('预算不足');
    expect(loop.outcome).toMatchObject({ status: 'budget_limit', repairRounds: 1 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('requires refreshed user confirmation between repair turns', async () => {
    const getConfig = vi.fn<VerificationLoopOptions['getConfig']>().mockResolvedValueOnce(config({ commands: [typecheck] })).mockResolvedValueOnce(undefined);
    const execute = vi.fn<VerificationLoopOptions['execute']>(async () => failed());
    const { loop } = setup({ execute, getConfig });
    expect((await loop.afterTurn(turn, changed)).feedback).toBeTruthy();
    expect((await loop.afterTurn(turn, changed)).summary).toContain('尚未确认');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight check and closes its command event', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const { loop, events } = setup({ execute: async () => { started(); return new Promise(() => undefined); } });
    const controller = new AbortController();
    const pending = loop.afterTurn(turn, changed, controller.signal);
    await running; controller.abort(new Error('ordinary cancellation'));
    await expect(pending).rejects.toThrow('ordinary cancellation');
    expect(loop.outcome?.status).toBe('cancelled');
    expect(events.filter((event) => event.type === 'command-start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'command-end')).toHaveLength(1);
  });

  it('times out a nonresponding executor without claiming verification passed', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const { loop } = setup({ getConfig: async () => config({ timeoutMs: 1_000 }), execute: async () => { started(); return new Promise(() => undefined); } });
    const pending = loop.afterTurn(turn, changed);
    await running; await vi.advanceTimersByTimeAsync(1_001);
    const result = await pending;
    expect(result.summary).toContain('执行超时'); expect(result.feedback).toBeUndefined();
    expect(loop.outcome?.status).toBe('unverified');
    expect(loop.outcome?.attempts[0].commands[0].result.timedOut).toBe(true);
  });

  it('treats host timeout and failed startup as unverified rather than code failures', async () => {
    const timed = setup({ execute: async () => ({ ...success(), timedOut: true }) });
    expect((await timed.loop.afterTurn(turn, changed)).summary).toContain('执行超时');
    expect(timed.loop.outcome?.status).toBe('unverified');
    const unavailable = setup({ execute: async () => { throw new Error('ordinary executor unavailable'); } });
    expect((await unavailable.loop.afterTurn(turn, changed)).summary).toContain('未能正常执行');
    expect(unavailable.loop.outcome?.status).toBe('unverified');
  });

  it('bounds each retained failure output to 4KB', async () => {
    const { loop } = setup({ execute: async () => ({ ...failed(), output: 'ordinary log\n'.repeat(1_000) + failed().output }), getConfig: async () => config({ commands: [typecheck], maxRepairRounds: 0 }) });
    await loop.afterTurn(turn, changed);
    const record = loop.outcome!.attempts[0].commands[0];
    expect(Buffer.byteLength(record.result.output, 'utf8')).toBeLessThanOrEqual(4_096);
    expect(record.diagnostics[0]).toMatchObject({ file: 'src/example.ts', line: 3, column: 2 });
  });
});
