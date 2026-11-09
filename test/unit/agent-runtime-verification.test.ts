import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime, type AgentRuntimeOptions } from '../../src/core/agent/AgentRuntime';
import { executeRun, type RunDependencies } from '../../src/core/agent/RunCoordinator';
import { AuditLog } from '../../src/core/audit/AuditLog';
import { CodeAuditor } from '../../src/core/audit/CodeAuditor';
import { GrowthEngine } from '../../src/core/growth/GrowthEngine';
import { MemoryStore } from '../../src/core/memory/MemoryStore';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { ModelRegistry } from '../../src/core/models/ModelRegistry';
import { ObservabilityEngine } from '../../src/core/observability/ObservabilityEngine';
import { ProjectContext } from '../../src/core/project/ProjectContext';
import { AgentRouter } from '../../src/core/routing/AgentRouter';
import { ModelQuota } from '../../src/core/routing/ModelQuota';
import { RoutingPolicyEngine } from '../../src/core/routing/RoutingPolicy';
import { DEFAULT_ROUTING_SETTINGS } from '../../src/core/routing/RoutingSettings';
import { BudgetExceededError } from '../../src/core/routing/RunBudget';
import { SessionStorage } from '../../src/core/storage/SessionStorage';
import { InMemoryTraceStore, TraceRecorder } from '../../src/core/trace/TraceRecorder';
import { ProjectProcessManager } from '../../src/core/tty/ProjectProcessManager';
import { VerificationLoop, type ProjectVerifyConfig } from '../../src/core/verify/VerificationLoop';

// Synthetic model replies stay on this local server; the integration uses the
// real Pi session, file tools, TypeScript compiler and project command manager.
const requests: any[] = [];
let replies: string[][] = [];
let server: http.Server;
let baseURL = '';
const directories: string[] = [];
const closers: Array<() => void> = [];
const sse = (value: object) => ['data: ' + JSON.stringify(value) + '\n\n', 'data: [DONE]\n\n'];
const text = (content: string) => sse({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
const write = (content: string, id: string, filePath = 'sum.ts') => sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: filePath, content }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 8 } });
const quote = (value: string) => process.platform === 'win32' ? '"' + value.replaceAll('"', '""') + '"' : String.fromCharCode(39) + value.replaceAll(String.fromCharCode(39), String.fromCharCode(39, 34, 39, 34, 39)) + String.fromCharCode(39);

beforeAll(async () => {
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of replies.shift() ?? text('unexpected extra request')) response.write(chunk);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
});
afterAll(() => { server.closeAllConnections(); server.close(); });
beforeEach(() => { requests.length = 0; replies = []; });
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(options: Partial<AgentRuntimeOptions> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-pi-verify-'));
  directories.push(directory);
  const projectRoot = path.join(directory, 'project');
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [], skipLibCheck: true }, files: ['sum.ts'] }));
  const model: ModelConfig = { id: 'fixture-model', name: 'Fixture model', provider: 'deepseek', modelId: 'deepseek-chat', apiKey: 'fixture-only', baseURL, enabled: true, priority: 0, capabilities: [], maxTokens: 4_000, contextWindow: 64_000, costPer1kTokens: { input: 0, output: 0 }, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 }, createdAt: new Date(), updatedAt: new Date() };
  const agent = new AgentRuntime({ agentDir: path.join(directory, 'agent'), defaultCwd: projectRoot, ...options });
  const manager = new ProjectProcessManager();
  closers.push(() => manager.dispose());
  const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const config: ProjectVerifyConfig = { version: 1, mode: 'quick', timeoutMs: 20_000, maxRepairRounds: 2, commands: [{ id: 'typecheck', label: 'typecheck', phase: 'quick', command: quote(process.execPath) + ' ' + quote(compiler) + ' --project tsconfig.json --pretty false' }], manifestFingerprint: 'f'.repeat(64), confirmedAt: new Date().toISOString() };
  return { directory, projectRoot, model, agent, manager, config };
}

function initialReplies() {
  return [write('export const total: number = "wrong";\n', 'initial-write'), text('Initial change.'), write('export const total: number = 2;\n', 'repair-write'), text('Fixed the type error.')];
}

describe('same-session project verification', () => {
  it('uses a real compiler failure to repair the same Pi session and accounts usage once in the coordinator', async () => {
    const setup = fixture();
    const { directory, projectRoot, model, agent, manager, config } = setup;
    replies = initialReplies();
    const models = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    models.registerModel(model);
    const observability = new ObservabilityEngine();
    const memory = new MemoryStore(':memory:');
    memory.setAutoExtract(false);
    const summaries = new SessionStorage(':memory:');
    const traceStore = new InMemoryTraceStore();
    closers.push(() => observability.close(), () => memory.close(), () => summaries.close());
    summaries.save({ id: 'session', title: 'fixture', prompt: '', output: '', createdAt: new Date(), updatedAt: new Date() });
    const events: Array<{ channel: string; payload: any }> = [];
    const check = vi.fn(async (command: ProjectVerifyConfig['commands'][number], context: { signal?: AbortSignal; timeoutMs: number }) => {
      const result = await manager.run({ projectRoot, command: command.command, timeoutMs: context.timeoutMs, signal: context.signal });
      return { exitCode: result.exitCode, output: result.output, durationMs: result.durationMs, timedOut: result.timedOut, cancelled: result.cancelled };
    });
    const deps: RunDependencies = {
      models, observability, memory, summaries, traces: new TraceRecorder(traceStore), quota: new ModelQuota(observability), growth: new GrowthEngine(), codeAuditor: new CodeAuditor(), auditLog: new AuditLog(path.join(directory, 'audit.jsonl')), controller: new AbortController(),
      routing: new RoutingPolicyEngine(new AgentRouter(models), { version: 1, defaults: { strategy: 'single' }, rules: [] }), routingSettings: { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'off' } },
      projectContext: { getRoot: () => projectRoot, getContextAsync: async () => undefined },
      invokeStreamed: async (current, prompt, maxTokens, onDelta, options) => ({ ...await agent.run({ ...options, model: current, prompt, maxTokens, onTextDelta: onDelta }), modelId: current.id }),
      createProjectVerification: (input) => new VerificationLoop({ projectRoot: input.projectRoot, getConfig: async () => config, execute: check, assertBudget: input.assertBudget, onEvent: input.onEvent }),
    };
    const result = await executeRun({ sessionId: 'session', runId: 'same-pi-session', prompt: 'Create the numeric total.', pinnedModelId: model.id, includeProjectContext: false }, deps, (channel, payload) => events.push({ channel, payload }));
    expect(check).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(projectRoot, 'sum.ts'), 'utf8')).toContain('= 2');
    expect(result).toMatchObject({ projectVerification: { status: 'passed', repairRounds: 1 }, metrics: { inputTokens: 180, outputTokens: 26 } });
    expect(result.output).toContain('Fixed the type error.');
    expect(result.output).toContain('验证通过');
    expect(result.output).not.toContain('Initial change.');
    expect(requests).toHaveLength(4);
    expect(requests[2].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool' }), expect.objectContaining({ role: 'assistant', content: 'Initial change.' })]));
    expect(JSON.stringify(requests[2].messages.filter((message: any) => message.role === 'user'))).toContain('TS2322');
    expect(events.filter((event) => event.channel === 'session:verification' && event.payload.phase === 'repair')).toHaveLength(1);
    expect(events.find((event) => event.channel === 'session:verification' && event.payload.phase === 'completed')?.payload).toMatchObject({ status: 'passed', repairRounds: 1 });
    const trace = traceStore.getTrace('same-pi-session')!;
    expect(trace.run).toMatchObject({ status: 'success', totalInputTokens: 180, totalOutputTokens: 26 });
    expect(trace.spans.filter((span) => span.kind === 'verify-command').map((span) => span.status)).toEqual(['failed', 'success']);
    expect(trace.spans.find((span) => span.kind === 'verify-repair')).toMatchObject({ status: 'success', attributes: { modifiedFiles: 1 } });
    expect(observability.getSummary()).toMatchObject({ verificationCount: 1, verificationPassRate: 1 });
  });

  it.each(['fixed', 'text-only', 'rejected'] as const)('rechecks actual files after same-session model review: %s', async (scenario) => {
    const { directory, projectRoot, model, agent, manager, config } = fixture();
    const initial = write('export const total: number = 1;\n', 'initial-valid-write', path.join(projectRoot, 'sum.ts'));
    replies = [initial, text('Initial implementation.'), ...(scenario === 'text-only' ? [text('I changed it in this answer only.')] : [write('export const total: number = ' + (scenario === 'fixed' ? '2' : '1') + ';\n', 'logic-repair-write'), text('Applied the logic change.')])];
    const models = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    models.registerModel(model);
    models.registerModel({ ...model, id: 'reviewer', modelId: 'reviewer', name: 'Synthetic reviewer' });
    const observability = new ObservabilityEngine();
    const memory = new MemoryStore(':memory:');
    memory.setAutoExtract(false);
    const summaries = new SessionStorage(':memory:');
    const traceStore = new InMemoryTraceStore();
    closers.push(() => observability.close(), () => memory.close(), () => summaries.close());
    summaries.save({ id: 'session', title: 'review fixture', prompt: '', output: '', createdAt: new Date(), updatedAt: new Date() });
    const events: Array<{ channel: string; payload: any }> = [];
    const reviews: string[] = [];
    const check = vi.fn(async (command: ProjectVerifyConfig['commands'][number], context: { signal?: AbortSignal; timeoutMs: number }) => {
      const result = await manager.run({ projectRoot, command: command.command, timeoutMs: context.timeoutMs, signal: context.signal });
      return { exitCode: result.exitCode, output: result.output, durationMs: result.durationMs, timedOut: result.timedOut, cancelled: result.cancelled };
    });
    const deps: RunDependencies = {
      models, observability, memory, summaries, traces: new TraceRecorder(traceStore), quota: new ModelQuota(observability), growth: new GrowthEngine(), codeAuditor: new CodeAuditor(), auditLog: new AuditLog(path.join(directory, 'audit.jsonl')), controller: new AbortController(),
      routing: new RoutingPolicyEngine(new AgentRouter(models), { version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'project-review', enabled: true, priority: 1, when: {}, then: { primaryModelId: model.id, strategy: 'plan+verify' } }] }),
      routingSettings: { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'off' }, utilityModelId: 'reviewer' },
      projectContext: { getRoot: () => projectRoot, getContextAsync: (paths, maxTokens) => new ProjectContext(projectRoot).buildContextAsync(paths, maxTokens) },
      invokeStreamed: async (current, prompt, maxTokens, onDelta, options) => ({ ...await agent.run({ ...options, model: current, prompt, maxTokens, onTextDelta: onDelta }), modelId: current.id }),
      createProjectVerification: (input) => new VerificationLoop({ projectRoot: input.projectRoot, getConfig: async () => config, execute: check, assertBudget: input.assertBudget, onEvent: input.onEvent }),
      createProvider: (current) => ({ modelId: current.id, invoke: async (prompt) => {
        reviews.push(prompt);
        const correct = prompt.includes('= 2;');
        return { content: JSON.stringify({ issues: correct ? [] : [{ severity: 'high', category: 'logic', description: 'The total is 1; the task requires 2.', suggestion: 'Set the exported total to 2.' }], approval: correct, overallScore: correct ? 95 : 40 }), inputTokens: 7, outputTokens: 3, modelId: current.id };
      } }),
    };
    const growth = vi.spyOn(deps.growth, 'recordFeedback');
    const result = await executeRun({ sessionId: 'session', runId: 'logic-' + scenario, prompt: 'Set the exported numeric total to 2.', includeProjectContext: false }, deps, (channel, payload) => events.push({ channel, payload }));
    const completed = events.filter((event) => event.channel === 'session:verification' && event.payload.phase === 'completed');
    expect(completed).toHaveLength(1);
    expect(reviews).toHaveLength(scenario === 'text-only' ? 1 : 2);
    expect(check).toHaveBeenCalledTimes(scenario === 'text-only' ? 1 : 2);
    expect(reviews[0]).toContain('Actual project check data');
    expect(reviews[0]).toContain('"status":"passed"');
    expect(result).toMatchObject({ projectVerification: { repairRounds: 1 } });
    if (scenario === 'fixed') {
      expect(fs.readFileSync(path.join(projectRoot, 'sum.ts'), 'utf8')).toContain('= 2;');
      expect(result).toMatchObject({ projectVerification: { status: 'passed' }, verification: { approved: true, revised: true }, metrics: { inputTokens: 194, outputTokens: 32 } });
      expect(result.output).toContain('验证通过');
      expect(completed[0].payload.status).toBe('passed');
    } else {
      expect(result).toMatchObject({ projectVerification: { status: 'failed' }, verification: { approved: false, revised: false } });
      expect(result.output).toContain('模型复核未通过');
      expect(result.output).not.toContain('验证通过');
      expect(growth.mock.calls.some(([feedback]) => feedback.completed && feedback.success)).toBe(false);
      expect(completed[0].payload.status).toBe('failed');
    }
    expect(requests).toHaveLength(scenario === 'text-only' ? 3 : 4);
    expect(JSON.stringify(requests[2].messages)).toContain('Initial implementation.');
  });

  it.each([{ maxToolCalls: 2 }, { maxToolRounds: 2 }])('keeps tool quotas across repairs: %j', async (options) => {
    const { agent, model, config, projectRoot } = fixture(options);
    replies = initialReplies();
    const execute = vi.fn(async () => ({ exitCode: 1, output: 'sum.ts(1,14): error TS2322: Type string is not assignable to number.', durationMs: 1 }));
    const loop = new VerificationLoop({ projectRoot, getConfig: async () => config, execute });
    const usage = vi.fn();
    const result = await agent.run({ model, projectRoot, prompt: 'Create the total.', onUsage: usage, afterTurn: (turn, context) => loop.afterTurn(turn, ['sum.ts'], context?.signal) });
    expect(result).toMatchObject({ stopReason: 'tool_limit', toolCalls: 2, inputTokens: 180, outputTokens: 26 });
    expect(result.content).toContain('验证未完成');
    expect(loop.outcome).toMatchObject({ status: 'unverified', repairRounds: 1 });
    expect(execute).toHaveBeenCalledOnce();
    expect(usage).toHaveBeenCalledTimes(4);
    expect(requests).toHaveLength(4);
    expect(requests[3].tools ?? []).toHaveLength(0);
  });

  it('retains the paid first answer when the repair request reaches the same run budget', async () => {
    const { agent, model, config, projectRoot } = fixture();
    replies = initialReplies();
    const loop = new VerificationLoop({ projectRoot, getConfig: async () => config, execute: async () => ({ exitCode: 1, output: 'Type error', durationMs: 1 }) });
    let modelRequests = 0;
    const usage = vi.fn();
    const result = await agent.run({ model, projectRoot, prompt: 'Create the total.', onUsage: usage, beforeModelRequest: () => { if (++modelRequests > 2) throw new BudgetExceededError('fixture repair budget exhausted'); }, afterTurn: (turn, context) => loop.afterTurn(turn, ['sum.ts'], context?.signal) });
    expect(result).toMatchObject({ stopReason: 'budget_limit', inputTokens: 90, outputTokens: 13, toolCalls: 1 });
    expect(result.content).toContain('Initial change.');
    expect(result.content).toContain('验证未完成');
    expect(loop.outcome?.status).toBe('budget_limit');
    expect(requests).toHaveLength(2);
    expect(usage).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending project check without starting another model turn', async () => {
    const { agent, model, config, projectRoot } = fixture();
    replies = initialReplies();
    const controller = new AbortController();
    const loop = new VerificationLoop({ projectRoot, getConfig: async () => config, execute: async () => { controller.abort(); return new Promise(() => undefined); } });
    await expect(agent.run({ model, projectRoot, prompt: 'Create the total.', signal: controller.signal, afterTurn: (turn, context) => loop.afterTurn(turn, ['sum.ts'], context?.signal) })).rejects.toThrow('任务已取消');
    expect(loop.outcome?.status).toBe('cancelled');
    expect(requests).toHaveLength(2);
  });

  it('reports a session deadline during project checks as unverified rather than user cancellation', async () => {
    const { agent, model, config, projectRoot } = fixture({ runTimeoutMs: 1_000 });
    replies = initialReplies();
    const loop = new VerificationLoop({ projectRoot, getConfig: async () => config, execute: async () => new Promise(() => undefined) });
    await expect(agent.run({ model, projectRoot, prompt: 'Create the total.', afterTurn: (turn, context) => loop.afterTurn(turn, ['sum.ts'], context?.signal) })).rejects.toThrow('任务执行超时');
    expect(loop.outcome?.status).toBe('unverified');
    expect(loop.outcome?.summary).toContain('会话超时');
    expect(requests).toHaveLength(2);
  });
});
