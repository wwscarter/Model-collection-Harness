import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore } from '../../src/core/bootstrap/createCore';
import { readEnvironmentModel } from '../../src/core/bootstrap/environmentModel';
import { SessionStorage } from '../../src/core/storage/SessionStorage';
import { parseCliArguments } from '../../src/cli/arguments';
import { createCliHost, type CliIO } from '../../src/cli/host';
import { runCli, type CliDependencies } from '../../src/cli/main';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function directory() { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-cli-')); directories.push(value); return value; }
function capture() {
  const stdin = Object.assign(new PassThrough(), { isTTY: false });
  const stdout = Object.assign(new PassThrough(), { isTTY: false });
  const stderr = Object.assign(new PassThrough(), { isTTY: false });
  let output = ''; let errors = '';
  stdout.on('data', (data) => { output += data; }); stderr.on('data', (data) => { errors += data; });
  return { io: { stdin, stdout, stderr } as unknown as CliIO, output: () => output, errors: () => errors };
}
function replayDependencies(): CliDependencies {
  const model = readEnvironmentModel({ NEWAI_MODEL_ID: 'ordinary-fixture', NEWAI_BASE_URL: 'http://127.0.0.1:12345/v1', NEWAI_API_KEY: 'synthetic-cli-only' })!;
  return { createCore: (host, options) => createCore(host, { ...options, initializePresets: false, models: [model], persistModels: false, enableMcp: false, invokeStreamed: async (current, _prompt, _max, delta) => { delta('Ordinary CLI response.'); return { content: 'Ordinary CLI response.', modelId: current.id, inputTokens: 12, outputTokens: 5 }; } }) };
}

describe('standalone CLI', () => {
  it('parses commands and keeps standalone data separate by default', () => {
    expect(parseCliArguments(['run', 'ordinary task', '--project', '.', '--model', 'stored-id', '--approval', 'auto', '--json'], '/tmp/ordinary-home')).toMatchObject({ command: 'run', prompt: 'ordinary task', model: 'stored-id', approval: 'auto', json: true, dataDir: '/tmp/ordinary-home/.newai', project: process.cwd() });
    expect(parseCliArguments(['eval', '--tags', 'code, fix', '--repeat', '3', '--smoke'])).toMatchObject({ command: 'eval', tags: ['code', 'fix'], repeat: 3, smoke: true });
    expect(() => parseCliArguments(['run'])).toThrow('请提供运行任务');
    expect(() => parseCliArguments(['run', 'ordinary', '--approval', 'invalid'])).toThrow('--approval');
  });

  it('prints model metadata without credential values', async () => {
    const terminal = capture();
    const code = await runCli(['models', 'list', '--json', '--data-dir', directory()], terminal.io, replayDependencies());
    expect(code).toBe(0);
    expect(JSON.parse(terminal.output())).toMatchObject({ channel: 'models:list', payload: [{ id: 'environment-model', credentialStatus: 'configured' }] });
    expect(terminal.output()).not.toContain('synthetic-cli-only');
    expect(terminal.output()).not.toContain('apiKey');
  });

  it('emits parseable NDJSON, persists the conversation and exposes its real trace', async () => {
    vi.stubEnv('NEWAI_MODEL_ID', '');
    const dataDir = directory();
    const terminal = capture();
    expect(await runCli(['run', 'Write an ordinary response.', '--model', 'environment-model', '--json', '--data-dir', dataDir], terminal.io, replayDependencies())).toBe(0);
    const events = terminal.output().trim().split('\n').map((line) => JSON.parse(line));
    const completed = events.find((event) => event.channel === 'session:completed');
    expect(completed.payload.output).toBe('Ordinary CLI response.');
    expect(events.find((event) => event.channel === 'session:chunk').payload.delta).toBe('Ordinary CLI response.');
    const sessions = new SessionStorage(path.join(dataDir, 'sessions.db'));
    try { expect(sessions.get(completed.payload.sessionId)).toMatchObject({ output: 'Ordinary CLI response.', runId: completed.payload.runId }); } finally { sessions.close(); }
    const trace = capture();
    expect(await runCli(['trace', 'show', completed.payload.runId, '--json', '--data-dir', dataDir], trace.io)).toBe(0);
    expect(JSON.parse(trace.output())).toMatchObject({ channel: 'trace:show', payload: { run: { id: completed.payload.runId, status: 'success' } } });
  });

  it('requires explicit yes when confirmation has no interactive terminal', async () => {
    const terminal = capture();
    const args = parseCliArguments(['run', 'ordinary']);
    const request = { kind: 'command' as const, command: 'node --version', cwd: process.cwd(), projectRoot: process.cwd(), decision: { decision: 'confirm' as const, reason: '普通确认' } };
    expect(await createCliHost(args, terminal.io, new AbortController().signal).confirm(request)).toBe(false);
    expect(terminal.errors()).toContain('非交互终端已拒绝');
    expect(await createCliHost({ ...args, yes: true }, terminal.io, new AbortController().signal).confirm(request)).toBe(true);
  });

  it('prints final verification additions after streamed text', () => {
    const terminal = capture();
    const host = createCliHost(parseCliArguments(['run', 'ordinary']), terminal.io, new AbortController().signal);
    host.emit('session:chunk', { delta: 'Ordinary response.' });
    host.emit('session:completed', { output: 'Ordinary response.\n\n验证通过。' });
    expect(terminal.output()).toBe('Ordinary response.\n\n验证通过。\n');
  });

  it('returns nonzero for a failed eval and emits a structured error for bad arguments', async () => {
    const terminal = capture();
    const evaluate = vi.fn<NonNullable<CliDependencies['eval']>>(async (_args, _signal) => ({ passed: false, summary: { passed: 0, failed: 1 } }));
    expect(await runCli(['eval', '--json', '--smoke'], terminal.io, { eval: evaluate })).toBe(1);
    expect(evaluate.mock.calls[0][0]).toMatchObject({ smoke: true });
    const invalid = capture();
    expect(await runCli(['run', '--json'], invalid.io)).toBe(1);
    expect(JSON.parse(invalid.output())).toMatchObject({ channel: 'error', payload: { cancelled: false } });
  });

  it('loads only explicit environment models and validates configured estimates', () => {
    expect(readEnvironmentModel({})).toBeUndefined();
    const config = readEnvironmentModel({ NEWAI_EVAL_MODEL_ID: 'evaluation-fixture', NEWAI_BASE_URL: 'http://127.0.0.1:12345/v1', NEWAI_INPUT_COST_PER_1K: '0.003', NEWAI_OUTPUT_COST_PER_1K: '0.006' }, ['NEWAI_EVAL', 'NEWAI'])!;
    expect(config).toMatchObject({ id: 'environment-model', modelId: 'evaluation-fixture', provider: 'custom', costPer1kTokens: { input: 0.003, output: 0.006 } });
    expect(() => readEnvironmentModel({ NEWAI_MODEL_ID: 'ordinary', NEWAI_INPUT_COST_PER_1K: '-1' })).toThrow('非负数字');
  });
});
