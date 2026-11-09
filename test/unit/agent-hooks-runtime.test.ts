import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../src/core/agent/AgentRuntime';
import { executeRun, type RunDependencies } from '../../src/core/agent/RunCoordinator';
import { AuditLog } from '../../src/core/audit/AuditLog';
import { CodeAuditor } from '../../src/core/audit/CodeAuditor';
import { GrowthEngine } from '../../src/core/growth/GrowthEngine';
import type { LoadedHook } from '../../src/core/hooks/HookConfig';
import { HookRunner, type HookResult } from '../../src/core/hooks/HookRunner';
import { MemoryStore } from '../../src/core/memory/MemoryStore';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { ModelRegistry } from '../../src/core/models/ModelRegistry';
import { ObservabilityEngine } from '../../src/core/observability/ObservabilityEngine';
import { AgentRouter } from '../../src/core/routing/AgentRouter';
import { ModelQuota } from '../../src/core/routing/ModelQuota';
import { RoutingPolicyEngine } from '../../src/core/routing/RoutingPolicy';
import { DEFAULT_ROUTING_SETTINGS } from '../../src/core/routing/RoutingSettings';
import { BudgetExceededError } from '../../src/core/routing/RunBudget';
import { SessionStorage } from '../../src/core/storage/SessionStorage';
import { InMemoryTraceStore, TraceRecorder } from '../../src/core/trace/TraceRecorder';
import { VerificationLoop, type ProjectVerifyConfig } from '../../src/core/verify/VerificationLoop';

// Isolated synthetic model responses drive real Pi sessions and ordinary file tools.
let server: http.Server;
let baseURL = '';
const requests: any[] = [];
const replies = new Map<string, string[][]>();
const cleanups: Array<() => void> = [];
const sse = (chunk: object) => ['data: ' + JSON.stringify(chunk) + '\n\n', 'data: [DONE]\n\n'];
const text = (content = 'Ordinary task completed.') => sse({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
const tool = (name: string, args: object) => sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 8 } });
const hook = (id: string, event: LoadedHook['event'], options: Partial<LoadedHook> = {}): LoadedHook => ({ id, key: 'global:' + id, event, source: 'global', path: '/ordinary/hooks.json', hash: 'b'.repeat(64), run: id, ...options });
beforeAll(async () => {
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of replies.get(parsed.model)?.shift() ?? text('No further ordinary action.')) response.write(chunk);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
});
beforeEach(() => { requests.length = 0; replies.clear(); });
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
afterAll(() => { server.closeAllConnections(); server.close(); });

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-hooks-pi-'));
  const projectRoot = path.join(directory, 'project');
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'source.ts'), 'export const source = 1;');
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const model = (id: string): ModelConfig => ({ id, name: id, provider: 'deepseek', apiKey: 'ordinary-fixture-only', baseURL, modelId: id, enabled: true, priority: 0, maxTokens: 4_000, contextWindow: 64_000, capabilities: [{ type: 'code', score: 70 }], costPer1kTokens: { input: 0, output: 0 }, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 }, createdAt: new Date(), updatedAt: new Date() });
  const models = new ModelRegistry(undefined, { initializePresets: false, persist: false });
  for (const id of ['executor', 'analyst-a', 'analyst-b']) models.registerModel(model(id));
  const agent = new AgentRuntime({ agentDir: path.join(directory, 'agent'), defaultCwd: directory });
  const observability = new ObservabilityEngine();
  const memory = new MemoryStore(':memory:');
  memory.setAutoExtract(false);
  const sessions = new SessionStorage(':memory:');
  sessions.save({ id: 'session', title: 'Ordinary task', prompt: '', output: '', createdAt: new Date(), updatedAt: new Date() });
  cleanups.push(() => { observability.close(); memory.close(); sessions.close(); });
  const traceStore = new InMemoryTraceStore();
  const received: Array<NonNullable<Parameters<RunDependencies['invokeStreamed']>[4]>['hookRunner']> = [];
  const deps: RunDependencies = {
    models, observability, memory, summaries: sessions, traces: new TraceRecorder(traceStore), quota: new ModelQuota(observability), growth: new GrowthEngine(), codeAuditor: new CodeAuditor(), auditLog: new AuditLog(path.join(directory, 'audit.jsonl')), controller: new AbortController(),
    routing: new RoutingPolicyEngine(new AgentRouter(models), { version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'executor', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy: 'single' } }] }), routingSettings: { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'off' } }, projectContext: { getRoot: () => projectRoot, getContextAsync: async () => undefined },
    invokeStreamed: async (current, prompt, maxTokens, delta, options) => { received.push(options?.hookRunner); return { ...await agent.run({ ...options, model: current, prompt, maxTokens, onTextDelta: delta }), modelId: current.id }; },
  };
  return { directory, projectRoot, agent, model: model('executor'), deps, traceStore, received };
}

describe('declarative Hooks in real Pi sessions', () => {
  it('formats a successful write, appends check feedback and applies an ordinary pre-tool hold', async () => {
    const value = fixture();
    const results: HookResult[] = [];
    const execute = vi.fn(async ({ hook: definition, command }: { hook: LoadedHook; command: string }) => {
      if (definition.id === 'format') {
        expect(command).toContain('sum.ts');
        fs.appendFileSync(path.join(value.projectRoot, 'sum.ts'), '\n// formatted');
      }
      return { exitCode: definition.id === 'check' ? 1 : 0, output: definition.id === 'check' ? 'Ordinary style suggestion.' : 'Formatted.' };
    });
    const runner = new HookRunner({ projectRoot: value.projectRoot, hooks: [hook('format', 'post_tool', { match: { tool: ['write'], glob: 'sum.ts' }, run: 'formatter {{files}}' }), hook('check', 'post_tool', { match: { tool: ['write'], glob: 'sum.ts' }, onFailure: 'report' }), hook('hold', 'pre_tool', { match: { tool: ['write'], glob: 'held.ts' }, action: 'block', reason: 'Use the ordinary project generator.', run: undefined })], execute, onResult: (result) => results.push(result) });
    replies.set('executor', [tool('write', { path: 'sum.ts', content: 'export const sum = 1;' }), tool('write', { path: 'held.ts', content: 'export const held = 1;' }), text()]);
    const result = await value.agent.run({ model: value.model, prompt: 'Write the ordinary module.', projectRoot: value.projectRoot, hookRunner: runner });
    expect(result.content).toBe('Ordinary task completed.');
    expect(fs.readFileSync(path.join(value.projectRoot, 'sum.ts'), 'utf8')).toContain('// formatted');
    expect(fs.existsSync(path.join(value.projectRoot, 'held.ts'))).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(results.map(({ id, status }) => [id, status])).toEqual([['format', 'passed'], ['check', 'failed'], ['hold', 'blocked']]);
    expect(JSON.stringify(requests[1].messages)).toContain('Ordinary style suggestion.');
    expect(JSON.stringify(requests[2].messages)).toContain('Use the ordinary project generator.');
  });

  it('shares one failure counter and two command slots across collaborators and a same-session repair', async () => {
    const value = fixture();
    const order: string[] = [];
    let active = 0;
    let maximum = 0;
    let runner: HookRunner | undefined;
    const factory = vi.fn<NonNullable<RunDependencies['createHookRuntime']>>(async (input) => {
      runner = new HookRunner({ projectRoot: value.projectRoot, hooks: [hook('start', 'run_start'), hook('check', 'post_tool', { match: { tool: ['read', 'write'], glob: '**/*.ts' }, onFailure: 'report' }), hook('end', 'run_end')], onStart: input.onStart, onResult: input.onResult, execute: async ({ hook: definition }) => {
        input.assertBudget();
        order.push(definition.id);
        active++; maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return { exitCode: definition.id === 'check' ? 1 : 0, output: definition.id === 'check' ? 'x'.repeat(4_500) + ' ordinary-tail' : 'ok', sandbox: { mode: 'synthetic-only' }, policy: { category: 'build', decision: 'allow' } };
      } });
      return { runner, diagnostics: [] };
    });
    value.deps.createHookRuntime = factory;
    const config: ProjectVerifyConfig = { version: 1, mode: 'quick', maxRepairRounds: 1, timeoutMs: 1_000, commands: [{ id: 'ordinary', label: 'ordinary check', phase: 'quick', command: 'ordinary-project-check' }], manifestFingerprint: 'a'.repeat(64), confirmedAt: new Date().toISOString() };
    let checks = 0;
    value.deps.createProjectVerification = (input) => new VerificationLoop({ projectRoot: input.projectRoot, getConfig: async () => config, assertBudget: input.assertBudget, onEvent: input.onEvent, execute: async () => ({ exitCode: ++checks === 1 ? 1 : 0, output: checks === 1 ? 'ordinary type mismatch' : '', durationMs: 1 }) });
    for (const id of ['analyst-a', 'analyst-b']) replies.set(id, [tool('read', { path: 'source.ts' }), text('Ordinary analysis.')]);
    replies.set('executor', [tool('write', { path: 'sum.ts', content: 'export const sum = 1;' }), text('Initial implementation.'), tool('write', { path: 'sum.ts', content: 'export const sum = 2;' }), text('Repaired implementation.')]);
    const completed = vi.fn(() => { expect(order.at(-1)).toBe('end'); });
    const output = await executeRun({ sessionId: 'session', runId: 'shared-hooks', prompt: 'Write the ordinary numeric module.', includeProjectContext: false, collaboratorModelIds: ['analyst-a', 'analyst-b'] }, value.deps, (channel) => { if (channel === 'session:completed') completed(); });
    expect(output).toMatchObject({ projectVerification: { status: 'passed', repairRounds: 1 } });
    expect(checks).toBe(2);
    expect(factory).toHaveBeenCalledOnce();
    expect(value.received).toHaveLength(3);
    for (const received of value.received) expect(received).toBe(runner);
    expect(order[0]).toBe('start');
    expect(order.at(-1)).toBe('end');
    expect(order.filter((id) => id === 'check')).toHaveLength(3);
    expect(maximum).toBe(2);
    expect(completed).toHaveBeenCalledOnce();
    const trace = value.traceStore.getTrace('shared-hooks')!;
    const hooks = trace.spans.filter((span) => span.kind === 'hook');
    expect(hooks.filter((span) => span.name === 'check').map((span) => span.attributes?.status)).toEqual(['failed', 'failed', 'failed', 'disabled']);
    const checked = hooks.find((span) => span.name === 'check')!;
    expect(checked.durationMs).toBeGreaterThanOrEqual(5);
    expect(checked.attributes).toMatchObject({ phase: 'post_tool', id: 'check', source: 'global', command: 'check', exitCode: 1, output: expect.stringContaining('ordinary-tail'), sandbox: { mode: 'synthetic-only' }, policy: { decision: 'allow' } });
    expect(Buffer.byteLength(checked.attributes?.output as string)).toBeLessThan(4_200);
    expect(trace.run.status).toBe('success');
    expect(hooks.every((span) => span.endedAt && span.status !== 'running')).toBe(true);
  });

  it.each(['pre_tool', 'post_tool'] as const)('keeps a rejected %s budget gate from starting another model request', async (phase) => {
    const value = fixture();
    const runner = new HookRunner({ projectRoot: value.projectRoot, hooks: [hook('check', phase)], execute: async () => { throw new BudgetExceededError('ordinary Hook budget'); } });
    replies.set('executor', [tool('write', { path: 'sum.ts', content: 'export const sum = 1;' }), text()]);
    const output = await value.agent.run({ model: value.model, prompt: 'Write the module.', projectRoot: value.projectRoot, hookRunner: runner });
    expect(output).toMatchObject({ stopReason: 'budget_limit', inputTokens: 40, outputTokens: 8 });
    expect(requests).toHaveLength(1);
    expect(fs.existsSync(path.join(value.projectRoot, 'sum.ts'))).toBe(phase === 'post_tool');
  });

  it('cancels a pending post-tool check with the existing run signal', async () => {
    const value = fixture();
    const controller = new AbortController();
    const results: HookResult[] = [];
    const runner = new HookRunner({ projectRoot: value.projectRoot, hooks: [hook('check', 'post_tool')], onResult: (result) => results.push(result), execute: async () => { controller.abort(); return new Promise(() => undefined); } });
    replies.set('executor', [tool('write', { path: 'sum.ts', content: 'export const sum = 1;' }), text()]);
    await expect(value.agent.run({ model: value.model, prompt: 'Write the module.', projectRoot: value.projectRoot, hookRunner: runner, signal: controller.signal })).rejects.toThrow('任务已取消');
    expect(requests).toHaveLength(1);
    expect(results[0].status).toBe('cancelled');
  });

  it.each(['success', 'failure'] as const)('keeps an unexpected run_end error from changing the original %s', async (status) => {
    const value = fixture();
    value.deps.projectContext.getRoot = () => undefined;
    const run = vi.fn(async (phase: string) => { if (phase === 'run_end') throw new Error('Ordinary end Hook unavailable.'); return { report: '', results: [] }; });
    value.deps.createHookRuntime = async () => ({ runner: { run }, diagnostics: [] });
    value.deps.invokeStreamed = async (model) => { if (status === 'failure') throw new Error('Original ordinary model failure.'); return { modelId: model.id, content: 'Original completed answer.', inputTokens: 10, outputTokens: 5 }; };
    const pending = executeRun({ sessionId: 'session', runId: 'end-' + status, prompt: 'Ordinary task.', pinnedModelId: 'executor', includeProjectContext: false }, value.deps, () => undefined);
    if (status === 'success') expect(await pending).toMatchObject({ output: 'Original completed answer.' });
    else await expect(pending).rejects.toThrow('Original ordinary model failure.');
    expect(run.mock.calls.map(([phase]) => phase)).toEqual(['run_start', 'run_end']);
    expect(value.traceStore.getTrace('end-' + status)?.spans.find((span) => span.name === 'run_end')).toMatchObject({ kind: 'hook', status: 'failed', errorMessage: 'Ordinary end Hook unavailable.' });
    expect(value.traceStore.getTrace('end-' + status)?.run.status).toBe(status === 'success' ? 'success' : 'failed');
  });
});
