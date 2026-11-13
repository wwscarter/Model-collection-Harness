import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeRun, type RunDependencies, type RunRequest } from '../../src/core/agent/RunCoordinator';
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
import { VerificationLoop, type ProjectVerifyConfig } from '../../src/core/verify/VerificationLoop';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-run-verify-state-'));
  const models = new ModelRegistry(undefined, { initializePresets: false, persist: false });
  const model = (id: string): ModelConfig => ({ id, name: id, provider: 'custom', apiKey: 'synthetic-only', baseURL: 'http://127.0.0.1/v1', modelId: id, enabled: true, priority: 0, maxTokens: 4_000, contextWindow: 32_000, capabilities: [{ type: 'code', score: 70 }], costPer1kTokens: { input: 0.001, output: 0.002 }, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 }, createdAt: new Date(), updatedAt: new Date() });
  models.registerModel(model('executor'));
  models.registerModel(model('reviewer'));
  const observability = new ObservabilityEngine();
  const memory = new MemoryStore(':memory:');
  memory.setAutoExtract(false);
  const summaries = new SessionStorage(':memory:');
  summaries.save({ id: 'session', title: 'synthetic verification state', prompt: '', output: '', createdAt: new Date(), updatedAt: new Date() });
  const traceStore = new InMemoryTraceStore();
  cleanups.push(() => { observability.close(); memory.close(); summaries.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const config: ProjectVerifyConfig = { version: 1, mode: 'quick', timeoutMs: 1_000, maxRepairRounds: 0, commands: [{ id: 'typecheck', label: 'typecheck', command: 'synthetic check command', phase: 'quick' }], manifestFingerprint: 'a'.repeat(64), confirmedAt: new Date().toISOString() };
  let writeFiles = true;
  let commandOnly = false;
  let stopReason = 'stop';
  const invoke = vi.fn<RunDependencies['invokeStreamed']>(async (current, _prompt, _max, delta, options) => {
    // Isolated synthetic adapter: coordinator behavior is tested here; the
    // separate Pi integration executes real file tools and the actual compiler.
    if (commandOnly && options?.enableTools !== false) {
      fs.writeFileSync(path.join(directory, 'sum.ts'), 'export const sum = 1;');
      options?.onToolEvent?.({ toolCallId: 'format', toolName: 'run_command', status: 'completed', details: { changedFiles: ['sum.ts'], changesIncomplete: false } });
    } else if (writeFiles && options?.enableTools !== false) {
      options?.onToolEvent?.({ toolCallId: 'write-fixture', toolName: 'write', status: 'running', args: { path: 'sum.ts' } });
      fs.writeFileSync(path.join(directory, 'sum.ts'), 'export const sum = 1;');
      options?.onToolEvent?.({ toolCallId: 'write-fixture', toolName: 'write', status: 'completed' });
    }
    const result = { content: 'Saved the implementation.\n\n' + String.fromCharCode(96).repeat(3) + 'ts\nconst sum = 1;\n' + String.fromCharCode(96).repeat(3), inputTokens: 10, outputTokens: 5, toolCalls: writeFiles ? 1 : 0, stopReason };
    options?.onUsage?.({ inputTokens: 10, outputTokens: 5 });
    delta(result.content);
    const decision = await options?.afterTurn?.(result, { signal: options.signal });
    return { ...result, content: result.content + (decision?.summary ? '\n\n' + decision.summary : ''), stopReason: decision?.stopReason ?? stopReason, modelId: current.id };
  });
  const deps: RunDependencies = {
    models, observability, memory, summaries, traces: new TraceRecorder(traceStore), quota: new ModelQuota(observability), growth: new GrowthEngine(), codeAuditor: new CodeAuditor(), auditLog: new AuditLog(path.join(directory, 'audit.jsonl')), controller: new AbortController(),
    routing: new RoutingPolicyEngine(new AgentRouter(models), { version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'single', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy: 'single' } }] }),
    routingSettings: { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'off' }, utilityModelId: 'reviewer' }, projectContext: { getRoot: () => directory, getContextAsync: (paths, maxTokens) => new ProjectContext(directory).buildContextAsync(paths, maxTokens) }, invokeStreamed: invoke,
  };
  const factory = vi.fn<NonNullable<RunDependencies['createProjectVerification']>>((input) => new VerificationLoop({ projectRoot: input.projectRoot, getConfig: async () => config, execute: async () => ({ exitCode: 0, output: '', durationMs: 1 }), assertBudget: input.assertBudget, onEvent: input.onEvent }));
  deps.createProjectVerification = factory;
  const growth = vi.spyOn(deps.growth, 'recordFeedback');
  const run = (request: Partial<RunRequest> = {}) => executeRun({ sessionId: 'session', prompt: 'Update the ordinary project.', includeProjectContext: false, ...request }, deps, () => undefined);
  return { deps, directory, config, factory, growth, traceStore, invoke, run, useCommand: () => { commandOnly = true; }, noWrites: () => { writeFiles = false; }, limited: () => { stopReason = 'tool_limit'; } };
}

describe('coordinator project verification outcomes', () => {
  it('runs project checks when a command accounts for all file changes', async () => {
    const f = fixture();
    f.useCommand();
    const result = await f.run();
    expect(f.factory).toHaveBeenCalledOnce();
    expect(result.projectVerification).toMatchObject({ changedFiles: ['sum.ts'] });
  });

  it.each(['no-write', 'disabled', 'limited'] as const)('does not trigger project checks for %s runs', async (kind) => {
    const value = fixture();
    if (kind === 'no-write') value.noWrites();
    if (kind === 'limited') value.limited();
    const result = await value.run(kind === 'disabled' ? { verificationMode: 'off' } : {});
    expect(value.factory).not.toHaveBeenCalled();
    expect(result.projectVerification).toBeUndefined();
    expect(value.deps.observability.getSummary().verificationCount).toBeUndefined();
  });

  it.each(['failed', 'unverified', 'budget_limit'] as const)('keeps %s checks from recording completed success', async (status) => {
    const value = fixture();
    value.factory.mockImplementation((input) => new VerificationLoop({ projectRoot: input.projectRoot, getConfig: async () => status === 'unverified' ? undefined : value.config, execute: async () => { if (status === 'budget_limit') throw new BudgetExceededError('synthetic check budget'); return { exitCode: 1, output: 'sum.ts(1,1): error TS2322: ordinary type mismatch', durationMs: 2 }; }, assertBudget: input.assertBudget, onEvent: input.onEvent }));
    const result = await value.run({ runId: 'check-' + status });
    expect(result.projectVerification).toMatchObject({ status });
    expect(result.output).toContain(status === 'failed' ? '验证未通过' : status === 'unverified' ? '未验证' : '验证未完成');
    expect(value.growth.mock.calls.some(([feedback]) => feedback.completed && feedback.success)).toBe(false);
    if (status === 'failed') expect(value.traceStore.getTrace('check-' + status)?.run.status).toBe('failed');
    if (status === 'budget_limit') expect(result.stopReason).toBe('budget_limit');
  });

  it('does not replace exhausted failed project checks with an answer-only model revision', async () => {
    const value = fixture();
    value.deps.routing = new RoutingPolicyEngine(new AgentRouter(value.deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'review', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy: 'plan+verify' } }] });
    value.factory.mockImplementation((input) => new VerificationLoop({ projectRoot: input.projectRoot, getConfig: async () => value.config, execute: async () => ({ exitCode: 1, output: 'sum.ts(1,1): error TS2322: mismatch', durationMs: 2 }), onEvent: input.onEvent }));
    let reviewed = '';
    value.deps.createProvider = (model) => ({ modelId: model.id, invoke: async (prompt) => { reviewed = prompt; return { modelId: model.id, content: JSON.stringify({ issues: [{ severity: 'high', category: 'logic', description: 'ordinary mismatch', suggestion: 'inspect the implementation' }], approval: false, overallScore: 30 }), inputTokens: 4, outputTokens: 2 }; } });
    const result = await value.run();
    expect(reviewed).toBe('');
    expect(result.verification).toBeUndefined();
    expect(result.projectVerification).toMatchObject({ status: 'failed' });
    expect(value.invoke).toHaveBeenCalledOnce();
    expect(result.output).toContain('验证未通过');
  });

  it('does not mistake a rejected review budget gate for a passing static fallback', async () => {
    const value = fixture();
    value.deps.models.updateModel('reviewer', { costPer1kTokens: { input: 1000, output: 1000 } });
    value.deps.routing = new RoutingPolicyEngine(new AgentRouter(value.deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'review', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy: 'plan+verify' } }] });
    const invoke = vi.fn(async () => ({ modelId: 'reviewer', content: JSON.stringify({ issues: [], approval: true, overallScore: 100 }), inputTokens: 4, outputTokens: 2 }));
    value.deps.createProvider = (model) => ({ modelId: model.id, invoke });
    const result = await value.run();
    expect(invoke).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stopReason: 'budget_limit', projectVerification: { status: 'budget_limit' } });
    expect(result.output).not.toContain('验证通过');
    expect(value.growth.mock.calls.some(([feedback]) => feedback.completed && feedback.success)).toBe(false);
    expect((result.verification as { approved?: boolean } | undefined)?.approved).not.toBe(true);
  });

  it('tracks a successful review repair when a compatible provider reuses the tool call ID', async () => {
    const value = fixture();
    value.config.maxRepairRounds = 1;
    value.deps.routing = new RoutingPolicyEngine(new AgentRouter(value.deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'review', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy: 'plan+verify' } }] });
    const reviews: string[] = [];
    value.deps.createProvider = (model) => ({ modelId: model.id, invoke: async (prompt) => {
      reviews.push(prompt);
      const correct = prompt.includes('= 2;');
      return { modelId: model.id, content: JSON.stringify({ issues: correct ? [] : [{ severity: 'high', category: 'logic', description: 'The ordinary sum must be 2.', suggestion: 'Set the exported sum to 2.' }], approval: correct, overallScore: correct ? 95 : 40 }), inputTokens: 0, outputTokens: 0 };
    } });
    value.invoke.mockImplementation(async (current, _prompt, _max, delta, options) => {
      // Isolated synthetic turns model a compatible service reusing call_0.
      for (const sum of [1, 2]) {
        options?.onToolEvent?.({ toolCallId: 'call_0', toolName: 'write', status: 'running', args: { path: 'sum.ts' } });
        fs.writeFileSync(path.join(value.directory, 'sum.ts'), 'export const sum = ' + sum + ';');
        options?.onToolEvent?.({ toolCallId: 'call_0', toolName: 'write', status: 'completed' });
        options?.onUsage?.({ inputTokens: 10, outputTokens: 5 });
        const turn = { content: 'Saved sum ' + sum + '.', inputTokens: 10, outputTokens: 5, toolCalls: 1, stopReason: 'stop' };
        const decision = await options?.afterTurn?.(turn, { signal: options.signal });
        if (sum === 1) expect(decision?.feedback).toBeTruthy();
        else {
          expect(decision?.feedback).toBeUndefined();
          const content = turn.content + '\n\n' + decision?.summary;
          delta(content);
          return { ...turn, content, inputTokens: 20, outputTokens: 10, toolCalls: 2, modelId: current.id };
        }
      }
      throw new Error('Synthetic fixture did not complete its repair turn');
    });
    const result = await value.run({ runId: 'reused-tool-id' });
    expect(result).toMatchObject({ projectVerification: { status: 'passed', repairRounds: 1, changedFiles: ['sum.ts'] }, verification: { approved: true, revised: true }, metrics: { inputTokens: 20, outputTokens: 10 } });
    expect(result.projectVerification).toMatchObject({ attempts: [expect.anything(), expect.anything()] });
    expect(result.toolCalls).toEqual([expect.objectContaining({ toolCallId: 'call_0', status: 'completed', args: { path: 'sum.ts' } })]);
    expect(reviews).toHaveLength(2);
    expect(value.traceStore.getTrace('reused-tool-id')?.spans.find((span) => span.kind === 'verify-repair')).toMatchObject({ status: 'success', attributes: { modifiedFiles: 1 } });
  });
});
