import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookStore } from '../../src/core/hooks/HookStore';
import { TrustStore } from '../../src/core/security/TrustStore';
import { createHookRuntime, type HookRuntimeContext } from '../../src/main/hookRuntime';

const native = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock('electron', () => ({ dialog: native }));
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); native.showMessageBox.mockReset(); for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-hook-runtime-')));
  directories.push(root);
  const agentDir = path.join(root, 'agent');
  const hookStore = new HookStore(agentDir, new TrustStore(path.join(root, 'trust.json')));
  const run = vi.fn(async (_request: { projectRoot: string; command: string; timeoutMs?: number; signal?: AbortSignal }) => ({ exitCode: 0 as number | null, output: 'ordinary check passed', timedOut: false, cancelled: false, sandbox: { mode: 'synthetic-only' } }));
  const ctx = { hookStore, workspaceRoot: root, projects: { getRoot: () => root }, preferences: { approvalMode: 'ask' }, getWindow: () => null, projectProcesses: { run } } as unknown as HookRuntimeContext;
  const config = { version: 1, hooks: [{ id: 'lint', event: 'run_start', run: 'npm run lint', timeoutMs: 2_000 }] };
  return { root, ctx, run, hookStore, config };
}

describe('native Hook command adapter', () => {
  it('confirms the command and forwards its timeout, run root, policy and sandbox evidence', async () => {
    const value = fixture();
    await value.hookStore.saveGlobal(value.config);
    native.showMessageBox.mockResolvedValue({ response: 1 });
    const assertBudget = vi.fn();
    const onStart = vi.fn();
    const onResult = vi.fn();
    const runtime = await createHookRuntime(value.ctx, { projectRoot: value.root, assertBudget, onStart, onResult });
    const result = await runtime.runner.run('run_start');
    expect(native.showMessageBox).toHaveBeenCalledOnce();
    expect(value.run).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: value.root, command: 'npm run lint', timeoutMs: 2_000, signal: expect.any(AbortSignal) }));
    expect(result.results[0]).toMatchObject({ status: 'passed', sandbox: { mode: 'synthetic-only' }, policy: { category: 'build', decision: 'confirm' } });
    expect(assertBudget).toHaveBeenCalledTimes(3);
    expect(onStart).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledOnce();
    expect(runtime.diagnostics).toEqual([]);
  });

  it('uses the existing automatic approval decision for an ordinary build check', async () => {
    const value = fixture();
    value.ctx.preferences.approvalMode = 'auto';
    await value.hookStore.saveGlobal(value.config);
    const runtime = await createHookRuntime(value.ctx, { projectRoot: value.root });
    expect((await runtime.runner.run('run_start')).results[0]).toMatchObject({ status: 'passed', policy: { decision: 'allow' } });
    expect(native.showMessageBox).not.toHaveBeenCalled();
    expect(value.run).toHaveBeenCalledOnce();
  });

  it('reports a declined command without starting a managed process', async () => {
    const value = fixture();
    await value.hookStore.saveGlobal(value.config);
    native.showMessageBox.mockResolvedValue({ response: 0 });
    const runtime = await createHookRuntime(value.ctx, { projectRoot: value.root });
    expect((await runtime.runner.run('run_start')).results[0]).toMatchObject({ status: 'failed', reason: '用户未批准 Hook 命令执行' });
    expect(value.run).not.toHaveBeenCalled();
  });

  it('loads trusted project Hooks and uses the app workspace for global-only runs', async () => {
    const value = fixture();
    value.ctx.preferences.approvalMode = 'auto';
    fs.mkdirSync(path.join(value.root, '.newai'));
    fs.writeFileSync(path.join(value.root, '.newai', 'hooks.json'), JSON.stringify(value.config));
    const pending = await createHookRuntime(value.ctx, { projectRoot: value.root });
    expect(pending.diagnostics).toContain('项目 Hooks 尚未信任');
    expect((await pending.runner.run('run_start')).results).toEqual([]);
    const project = (await value.hookStore.list(value.root)).project!;
    await value.hookStore.trustProject(value.root, project.hash);
    const trusted = await createHookRuntime(value.ctx, { projectRoot: value.root });
    expect((await trusted.runner.run('run_start')).results[0].source).toBe('project');
    await value.hookStore.saveGlobal(value.config);
    const global = await createHookRuntime(value.ctx);
    expect((await global.runner.run('run_start')).results.map((result) => result.source)).toEqual(['global']);
    expect(value.run.mock.calls.at(-1)?.[0].projectRoot).toBe(value.root);
  });

  it('keeps an executor timeout from becoming a successful Hook result', async () => {
    const value = fixture();
    value.ctx.preferences.approvalMode = 'auto';
    await value.hookStore.saveGlobal(value.config);
    value.run.mockResolvedValueOnce({ exitCode: 0, output: '', timedOut: true, cancelled: false, sandbox: { mode: 'synthetic-only' } });
    const runtime = await createHookRuntime(value.ctx, { projectRoot: value.root });
    expect((await runtime.runner.run('run_start')).results[0]).toMatchObject({ status: 'failed', exitCode: null, output: 'Hook 命令执行超时' });
  });
});
