import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createProjectVerification } from '../../src/main/projectVerification';
import type { MainContext } from '../../src/main/MainContext';

const native = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock('electron', () => ({ dialog: native }));

it.each([
  { scripts: {}, reason: '项目未提供可运行的检查命令' },
  { scripts: { test: 'echo fixture-tests' }, reason: '快速模式没有可运行的检查' },
])('explains unavailable checks before asking for approval: $reason', async ({ scripts, reason }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-no-checks-'));
  const projectRoot = path.join(directory, 'project');
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ scripts }));
  native.showMessageBox.mockReset();
  const ctx = { dataDir: path.join(directory, 'data'), getWindow: () => null } as unknown as MainContext;
  try {
    const verifier = createProjectVerification(ctx, { projectRoot, mode: 'quick', runId: 'synthetic-fixture', assertBudget: () => undefined, onEvent: () => undefined });
    await verifier.afterTurn({ content: 'fixture changed' }, ['src/demo.ts']);
    expect(verifier.outcome).toMatchObject({ status: 'unverified', summary: expect.stringContaining(reason) });
    expect(native.showMessageBox).not.toHaveBeenCalled();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it('confirms inferred scripts before persisting them and asks again after manifest changes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-verification-host-'));
  const projectRoot = path.join(directory, 'project');
  fs.mkdirSync(projectRoot);
  const manifest = path.join(projectRoot, 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({ scripts: { lint: 'echo fixture-check' } }));
  native.showMessageBox.mockReset().mockResolvedValue({ response: 1 });
  const run = vi.fn(async () => ({ exitCode: 0, output: 'fixture passed', durationMs: 1, timedOut: false, cancelled: false }));
  const ctx = { dataDir: path.join(directory, 'data'), getWindow: () => null, preferences: { approvalMode: 'auto' }, projectProcesses: { run }, projects: { getRoot: () => projectRoot } } as unknown as MainContext;
  const make = () => createProjectVerification(ctx, { projectRoot, mode: 'quick', runId: 'synthetic-fixture-run', assertBudget: () => undefined, onEvent: () => undefined });
  try {
    const first = make();
    await first.afterTurn({ content: 'fixture changed' }, ['src/demo.ts']);
    expect(first.outcome?.status).toBe('passed');
    expect(native.showMessageBox).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: 'npm run lint', projectRoot }));
    await make().afterTurn({ content: 'fixture changed' }, ['src/demo.ts']);
    expect(native.showMessageBox).toHaveBeenCalledTimes(1);
    fs.writeFileSync(manifest, JSON.stringify({ scripts: { lint: 'echo updated-fixture-check' } }));
    native.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const declined = make();
    await declined.afterTurn({ content: 'fixture changed' }, ['src/demo.ts']);
    expect(native.showMessageBox).toHaveBeenCalledTimes(2);
    expect(declined.outcome?.status).toBe('unverified');
    expect(run).toHaveBeenCalledTimes(2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
