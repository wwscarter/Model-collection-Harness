import { describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
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

  it('enforces the per-run tool-call budget', async () => {
    const runtime = new ToolRuntime({ cwd: process.cwd(), maxCalls: 1 });
    const wrapped = runtime.wrap([tool('ls', async () => result('ok'))]);
    await wrapped[0].execute(...args);
    await expect(wrapped[0].execute(...args)).rejects.toThrow('上限');
  });
});
