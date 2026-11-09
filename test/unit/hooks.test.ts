import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { validateHookConfig, type LoadedHook } from '@core/hooks/HookConfig';
import { HookStore } from '@core/hooks/HookStore';
import { HookRunner } from '@core/hooks/HookRunner';
import { TrustStore } from '@core/security/TrustStore';
import { BudgetExceededError } from '@core/routing/RunBudget';

const temporary: string[] = [];
function directory() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-hooks-')); temporary.push(root); return root; }
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const config = { version: 1, hooks: [{ id: 'format', event: 'post_tool', match: { tool: ['write', 'edit'], glob: '**/*.ts' }, run: 'formatter {{files}}', onFailure: 'report' }] };
function hook(overrides: Partial<LoadedHook> = {}): LoadedHook { return { id: 'format', event: 'post_tool', run: 'formatter {{files}}', key: 'global:format', source: 'global', path: '/app/hooks.json', hash: 'a'.repeat(64), ...overrides }; }

describe('declarative Hook configuration', () => {
  it('validates the configuration and returns an independent snapshot', () => { const parsed = validateHookConfig(config); parsed.hooks[0].id = 'changed'; expect(config.hooks[0].id).toBe('format'); });
  it('validates duplicate IDs, lifecycle matching and block configuration', () => {
    expect(() => validateHookConfig({ version: 1, hooks: [config.hooks[0], config.hooks[0]] })).toThrow('重复');
    expect(() => validateHookConfig({ version: 1, hooks: [{ id: 'notice', event: 'run_end', match: { tool: ['write'] }, run: 'notify' }] })).toThrow('匹配');
    expect(() => validateHookConfig({ version: 1, hooks: [{ id: 'hold', event: 'post_tool', action: 'block', reason: 'Use formatter' }] })).toThrow('pre_tool');
  });
  it('accepts complete file placeholders and validates formatting templates', () => {
    expect(() => validateHookConfig(config)).not.toThrow();
    for (const run of ['formatter "{{files}}"', 'formatter prefix{{files}}', 'formatter {{other}}']) expect(() => validateHookConfig({ version: 1, hooks: [{ id: 'format', event: 'post_tool', run }] })).toThrow('占位符');
  });
  it('requires explicit hash approval for the current project configuration', async () => {
    const root = directory(); const agent = directory(); fs.mkdirSync(path.join(root, '.newai'));
    const text = JSON.stringify(config); fs.writeFileSync(path.join(root, '.newai/hooks.json'), text);
    const store = new HookStore(agent, new TrustStore(path.join(agent, 'trust.json')));
    expect((await store.load(root)).hooks).toEqual([]);
    const hash = createHash('sha256').update(text).digest('hex');
    await store.trustProject(root, hash); expect((await store.load(root)).hooks).toHaveLength(1);
    fs.writeFileSync(path.join(root, '.newai/hooks.json'), text + '\n'); expect((await store.load(root)).hooks).toEqual([]);
    await expect(store.trustProject(root, hash)).rejects.toThrow('变化');
  });
  it('round-trips global configuration and reports incomplete project JSON', async () => {
    const root = directory(); const agent = directory(); const store = new HookStore(agent, new TrustStore(path.join(agent, 'trust.json')));
    await store.saveGlobal(config); expect((await store.load()).hooks[0].source).toBe('global');
    fs.mkdirSync(path.join(root, '.newai')); fs.writeFileSync(path.join(root, '.newai/hooks.json'), '{');
    expect((await store.list(root)).diagnostics.length).toBe(1);
  });
});

describe('per-run Hook execution', () => {
  it('matches tool and glob, shell-quotes ordinary file names', async () => {
    const root = directory(); const execute = vi.fn(async (_request: { command: string }) => ({ exitCode: 0, output: 'ok' }));
    const runner = new HookRunner({ projectRoot: root, hooks: [hook({ match: { tool: ['write'], glob: '**/*.ts' } })], execute });
    await runner.run('post_tool', { toolName: 'read', files: ['src/a.ts'] }); expect(execute).not.toHaveBeenCalled();
    const result = await runner.run('post_tool', { toolName: 'write', files: ['src/a file.ts'] });
    expect(result.results[0].status).toBe('passed'); expect(execute.mock.calls[0][0].command).toContain('a\ file.ts');
  });
  it('uses at most two command slots across simultaneous events', async () => {
    let active = 0; let maximum = 0;
    const runner = new HookRunner({ projectRoot: directory(), hooks: [hook({ run: 'formatter' })], execute: async () => { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1; return { exitCode: 0, output: '' }; } });
    await Promise.all(Array.from({ length: 6 }, () => runner.run('post_tool'))); expect(maximum).toBe(2);
  });
  it('reports post failures and disables the hook after three consecutive failures', async () => {
    const execute = vi.fn(async () => ({ exitCode: 1, output: 'x'.repeat(5000) }));
    const runner = new HookRunner({ projectRoot: directory(), hooks: [hook({ run: 'formatter' })], execute });
    for (let index = 0; index < 3; index += 1) { const result = await runner.run('post_tool'); expect(result.report).toContain('失败'); expect(Buffer.byteLength(result.results[0].output)).toBeLessThan(4200); }
    expect((await runner.run('post_tool')).results[0].status).toBe('disabled'); expect(execute).toHaveBeenCalledTimes(3);
  });
  it('resets the consecutive failure count on success', async () => {
    const execute = vi.fn().mockResolvedValueOnce({ exitCode: 1, output: '' }).mockResolvedValueOnce({ exitCode: 0, output: '' }).mockResolvedValue({ exitCode: 1, output: '' });
    const runner = new HookRunner({ projectRoot: directory(), hooks: [hook({ run: 'formatter' })], execute });
    for (let index = 0; index < 4; index += 1) await runner.run('post_tool');
    expect((await runner.run('post_tool')).results[0].status).toBe('failed');
    expect((await runner.run('post_tool')).results[0].status).toBe('disabled');
  });
  it('blocks a matching tool declaratively and skips checks after their failure limit', async () => {
    const runner = new HookRunner({ projectRoot: directory(), hooks: [hook({ event: 'pre_tool', action: 'block', run: undefined, reason: 'Use the package manager' })], execute: vi.fn() });
    expect((await runner.run('pre_tool')).blocked).toBe('Use the package manager');
    const check = new HookRunner({ projectRoot: directory(), hooks: [hook({ event: 'pre_tool', run: 'check-format' })], execute: async () => ({ exitCode: 1, output: 'format failed' }) });
    for (let index = 0; index < 3; index += 1) expect((await check.run('pre_tool')).blocked).toBeTruthy();
    expect((await check.run('pre_tool')).blocked).toBeUndefined();
  });
  it('honors timeout independently of the executor and cancellation before execution', async () => {
    const runner = new HookRunner({ projectRoot: directory(), hooks: [hook({ run: 'formatter', timeoutMs: 100 })], execute: async () => new Promise(() => {}) });
    expect((await runner.run('post_tool')).results[0].status).toBe('failed');
    const controller = new AbortController(); controller.abort(new Error('user cancelled'));
    await expect(runner.run('post_tool', { signal: controller.signal })).rejects.toThrow('user cancelled');
  });
  it('settles concurrent commands before propagating a rejected budget gate', async () => {
    let finished = false;
    const runner = new HookRunner({ projectRoot: directory(), hooks: [hook({ id: 'first', key: 'global:first', run: 'ordinary-first-check' }), hook({ id: 'second', key: 'global:second', run: 'ordinary-second-check' })], execute: async ({ hook: current }) => {
      if (current.id === 'first') throw new BudgetExceededError('ordinary Hook budget');
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
      return { exitCode: 0, output: '' };
    } });
    await expect(runner.run('post_tool')).rejects.toThrow('ordinary Hook budget');
    expect(finished).toBe(true);
  });
});
