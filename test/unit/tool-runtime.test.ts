import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { createReadToolDefinition, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { ToolRuntime } from '../../src/core/tools/ToolRuntime';

function tool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return { name, label: name, description: name, parameters: Type.Object({}), execute } as unknown as ToolDefinition;
}

const args = ['call-1', { path: 'README.md' }, undefined, undefined, {}] as Parameters<ToolDefinition['execute']>;

const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });

describe('ToolRuntime', () => {
  it('truncates oversized model-facing output and marks it', async () => {
    const runtime = new ToolRuntime({ cwd: process.cwd(), policies: { read: { name: 'read', maxResultChars: 10 } } });
    const wrapped = runtime.wrap([tool('read', async () => result('x'.repeat(100)))]);
    const output = await wrapped[0].execute(...args);
    expect(output.content[0].type).toBe('text');
    expect((output.content[0] as { text: string }).text).toContain('结果已截断');
    expect((output.content[0] as { text: string }).text.length).toBeLessThan(100);
  });

  it('caches read-only tool results within the TTL', async () => {
    let calls = 0;
    const runtime = new ToolRuntime({ cwd: process.cwd(), policies: { web_fetch: { name: 'web_fetch', maxResultChars: 1_000, cacheTtlMs: 60_000 } } });
    const wrapped = runtime.wrap([tool('web_fetch', async () => { calls += 1; return result('cached'); })]);
    const callArgs = ['call-1', { url: 'https://example.com' }, undefined, undefined, {}] as Parameters<ToolDefinition['execute']>;
    await wrapped[0].execute(...callArgs);
    await wrapped[0].execute(...callArgs);
    expect(calls).toBe(1);
  });

  it('caches file reads separately for different offsets and limits', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-read-cache-'));
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'alpha\nbeta\ngamma\ndelta\n');
    const read = createReadToolDefinition(directory);
    const execute = vi.fn(read.execute);
    const wrapped = new ToolRuntime({ cwd: directory }).wrap([{ ...read, execute } as unknown as ToolDefinition])[0];
    const invoke = (params: { path: string; offset: number; limit: number }) => wrapped.execute('read-page', params, undefined, undefined, {} as never);
    try {
      const first = await invoke({ path: 'notes.txt', offset: 1, limit: 1 });
      const second = await invoke({ path: 'notes.txt', offset: 2, limit: 1 });
      const longer = await invoke({ path: 'notes.txt', offset: 2, limit: 2 });
      const cached = await invoke({ limit: 2, offset: 2, path: 'notes.txt' });
      expect((first.content[0] as { text: string }).text.split('\n')[0]).toBe('alpha');
      expect((second.content[0] as { text: string }).text.split('\n')[0]).toBe('beta');
      expect((longer.content[0] as { text: string }).text).toContain('beta\ngamma');
      expect(cached).toEqual(longer);
      expect(execute).toHaveBeenCalledTimes(3);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('enforces the per-run tool-call budget', async () => {
    const runtime = new ToolRuntime({ cwd: process.cwd(), maxCalls: 1 });
    const wrapped = runtime.wrap([tool('ls', async () => result('ok'))]);
    await wrapped[0].execute(...args);
    await expect(wrapped[0].execute(...args)).rejects.toThrow('上限');
  });

  it('stops starting tool work after the result budget has been consumed', async () => {
    const runtime = new ToolRuntime({ cwd: process.cwd(), maxResultCharsTotal: 3 });
    const write = vi.fn(async () => result('saved'));
    const wrapped = runtime.wrap([tool('read', async () => result('abcdef')), tool('write', write)]);
    await wrapped[0].execute(...args);
    expect(runtime.getBudgetState()).toMatchObject({ calls: 1, resultChars: 3, exhaustedBy: 'output' });
    await expect(wrapped[1].execute(...args)).rejects.toThrow('工具输出额度已用尽');
    expect(write).not.toHaveBeenCalled();
  });

  it('ends a tool wait when the tool ignores its timeout signal', async () => {
    const wrapped = new ToolRuntime({ cwd: process.cwd(), policies: { slow: { name: 'slow', maxResultChars: 100, timeoutMs: 20 } } })
      .wrap([tool('slow', async () => new Promise(() => undefined))])[0];
    await expect(wrapped.execute(...args)).rejects.toThrow('执行超时');
  });

  it('honors cancellation before serving a cached result', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => result('cached'));
    const wrapped = new ToolRuntime({ cwd: process.cwd() }).wrap([tool('ls', execute)])[0];
    await wrapped.execute(...args);
    controller.abort(new Error('cancelled by user'));
    await expect(wrapped.execute('cancelled', args[1], controller.signal, undefined, {} as never)).rejects.toThrow('cancelled by user');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refreshes directory listings after project mutations', async () => {
    let files = 'before.txt';
    const ls = vi.fn(async () => result(files));
    const tools = new ToolRuntime({ cwd: process.cwd() }).wrap([
      tool('ls', ls),
      tool('write', async () => { files = 'before.txt after.txt'; return result('saved'); }),
    ]);
    await tools[0].execute(...args);
    await tools[1].execute(...args);
    const refreshed = await tools[0].execute(...args);
    expect(refreshed.content[0]).toMatchObject({ text: 'before.txt after.txt' });
    expect(ls).toHaveBeenCalledTimes(2);
  });

  it('retries read-only errors instead of caching them', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ ...result('temporarily unavailable'), isError: true })
      .mockResolvedValueOnce(result('recovered'));
    const wrapped = new ToolRuntime({ cwd: process.cwd() }).wrap([tool('ls', execute)])[0];
    await wrapped.execute(...args);
    expect((await wrapped.execute(...args)).content[0]).toMatchObject({ text: 'recovered' });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
