import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { ModelRegistry } from '../../src/core/models/ModelRegistry';
import { AgentRouter } from '../../src/core/routing/AgentRouter';
import { RoutingPolicyEngine, type RoutingPolicy } from '../../src/core/routing/RoutingPolicy';
import { ModelQuota } from '../../src/core/routing/ModelQuota';
import { ObservabilityEngine } from '../../src/core/observability/ObservabilityEngine';
import { TraceRecorder } from '../../src/core/trace/TraceRecorder';
import { InMemoryTraceStore } from '../../src/core/trace/TraceRecorder';
import { GrowthEngine } from '../../src/core/growth/GrowthEngine';
import { CodeAuditor } from '../../src/core/audit/CodeAuditor';
import { AuditLog } from '../../src/core/audit/AuditLog';
import { MemoryStore } from '../../src/core/memory/MemoryStore';
import { SessionStorage } from '../../src/core/storage/SessionStorage';
import { executeRun, type RunDependencies } from '../../src/core/agent/RunCoordinator';
import type { ContextTurn } from '../../src/core/context/ContextAssembler';
import * as summaryService from '../../src/core/context/SummaryService';
import { modelContextBudget } from '../../src/core/context/ContextBudget';
import { DEFAULT_ROUTING_SETTINGS } from '../../src/core/routing/RoutingSettings';
import { PlanController } from '../../src/core/planning/PlanController';
import type { RunPlan } from '../../src/core/planning/PlanTypes';

function model(id: string, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id, name: id, provider: 'custom', apiKey: 'test', baseURL: 'http://127.0.0.1/v1', modelId: id,
    enabled: true, priority: 0, capabilities: [{ type: 'code', score: 70 }], maxTokens: 4096,
    costPer1kTokens: { input: 0.01, output: 0.02 }, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 },
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...overrides,
  };
}

function makeDeps(models: ModelConfig[], run: RunDependencies['invokeStreamed'], createProvider?: RunDependencies['createProvider']): { deps: RunDependencies; traceStore: InMemoryTraceStore; cleanup: () => void } {
  const registry = new ModelRegistry(undefined, { initializePresets: false, persist: false });
  for (const item of models) registry.registerModel(item);
  const observability = new ObservabilityEngine();
  const traceStore = new InMemoryTraceStore();
  const traceRecorder = new TraceRecorder(traceStore);
  const growth = new GrowthEngine();
  const codeAuditor = new CodeAuditor();
  const memory = new MemoryStore(':memory:');
  const sessions = new SessionStorage(':memory:');
  sessions.save({ id: 'session-1', title: 't', prompt: '', output: '', createdAt: new Date(), updatedAt: new Date() });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-run-'));
  const auditLog = new AuditLog(path.join(directory, 'audit.jsonl'));
  const policy: RoutingPolicy = { version: 1, rules: [], defaults: { strategy: 'single' } };
  const routing = new RoutingPolicyEngine(new AgentRouter(registry, growth), policy);
  const deps: RunDependencies = {
    models: registry, routing, quota: new ModelQuota(observability), traces: traceRecorder,
    observability, growth, codeAuditor, auditLog, memory, summaries: sessions,
    projectContext: { getRoot: () => undefined, getContextAsync: async () => undefined },
    controller: new AbortController(), invokeStreamed: run, ...(createProvider ? { createProvider } : {}),
  };
  return { deps, traceStore, cleanup: () => { observability.close(); memory.close(); sessions.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

describe('RunCoordinator', () => {
  it('retains a tool-limit stage summary and usage without treating the task as completed', async () => {
    const summary = '阶段总结：已检查入口文件；剩余适配尚未完成。\n\n```ts\nconst completedStep = true;\n```';
    const provider = vi.fn(() => { throw new Error('Optional verification or extraction must not run after a tool limit'); });
    const invoke = vi.fn(async (current: ModelConfig, _prompt: string, _max: number, onDelta: (delta: string) => void) => {
      onDelta(summary);
      return { content: summary, inputTokens: 0, outputTokens: 17, modelId: current.id, stopReason: 'tool_limit' };
    });
    const { deps, traceStore, cleanup } = makeDeps([model('executor', { contextWindow: 32_000 }), model('utility', { contextWindow: 32_000 })], invoke, provider);
    deps.routing = new RoutingPolicyEngine(new AgentRouter(deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [
      { id: 'verify', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy: 'escalate' } },
    ] });
    deps.memory.setAutoExtract(true);
    const growth = vi.spyOn(deps.growth, 'recordFeedback');
    const events: Array<{ channel: string; payload: any }> = [];
    try {
      const output = await executeRun({ sessionId: 'session-1', runId: 'tool-limit', prompt: 'Continue the implementation', includeProjectContext: false }, deps, (channel, payload) => events.push({ channel, payload }));
      expect(output).toMatchObject({ output: summary, stopReason: 'tool_limit', metrics: { stopReason: 'tool_limit', inputTokens: 0, outputTokens: 17 }, extractedMemoryIds: [] });
      expect((output.metrics as { totalCost: number }).totalCost).toBeCloseTo(0.00034);
      expect(output.verification).toBeUndefined();
      expect(provider).not.toHaveBeenCalled();
      expect(growth).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledOnce();
      expect(deps.observability.getRecent(1)[0]).toMatchObject({ status: 'success', inputTokens: 0, outputTokens: 17 });
      const trace = traceStore.getTrace('tool-limit');
      expect(trace?.run).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('任务尚未完成'), totalInputTokens: 0, totalOutputTokens: 17 });
      expect(trace?.spans.find((span) => span.kind === 'run')).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('工具执行额度') });
      expect(trace?.spans.find((span) => span.name === 'execution')).toMatchObject({ status: 'failed', attributes: { stopReason: 'tool_limit' } });
      expect(events.find((event) => event.channel === 'session:completed')?.payload).toMatchObject({ output: summary, stopReason: 'tool_limit', metrics: { stopReason: 'tool_limit' } });
    } finally { cleanup(); }
  });

  it('labels a limited subagent report as partial while allowing the final executor to finish', async () => {
    const lead = model('lead', { name: 'Lead', contextWindow: 32_000, capabilities: [{ type: 'reasoning', score: 95 }] });
    const reviewer = model('reviewer', { name: 'Reviewer', contextWindow: 32_000 });
    const plan = JSON.stringify({ mode: 'delegate', taskType: 'general', complexity: 'medium', subagents: [{ modelId: 'reviewer', role: 'analysis', instruction: 'Inspect the pending work.' }], verify: false });
    let finalPrompt = '';
    const { deps, traceStore, cleanup } = makeDeps([lead, reviewer], async (current, prompt, _max, onDelta) => {
      const limited = current.id === 'reviewer';
      const content = limited ? '已检查入口；剩余模块尚待检查。' : 'Final completed answer';
      if (!limited) finalPrompt = prompt;
      onDelta(content);
      return { content, inputTokens: 10, outputTokens: 5, modelId: current.id, stopReason: limited ? 'tool_limit' : 'stop' };
    }, () => ({ modelId: lead.id, invoke: async () => ({ content: plan, inputTokens: 20, outputTokens: 10, modelId: lead.id }) }));
    const events: Array<{ channel: string; payload: any }> = [];
    const growth = vi.spyOn(deps.growth, 'recordFeedback');
    try {
      const output = await executeRun({ sessionId: 'session-1', runId: 'partial-agent', prompt: 'Complete the task', complexity: 'high', includeProjectContext: false }, deps, (channel, payload) => events.push({ channel, payload }));
      expect(finalPrompt).toContain('子任务部分完成');
      expect(finalPrompt).toContain('不可视为完整成果');
      expect(finalPrompt).toContain('剩余模块尚待检查');
      expect(output).toMatchObject({ stopReason: 'stop', output: 'Final completed answer', metrics: { stopReason: 'stop' }, agentMessages: [{ status: 'failed', content: '已检查入口；剩余模块尚待检查。', error: expect.stringContaining('部分完成'), stopReason: 'tool_limit' }], agentReports: [{ stopReason: 'tool_limit', content: expect.stringContaining('子任务部分完成') }] });
      expect(traceStore.getTrace('partial-agent')?.run.status).toBe('success');
      expect(traceStore.getTrace('partial-agent')?.spans.find((span) => span.name === 'collaborator')).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('部分完成'), attributes: { stopReason: 'tool_limit' } });
      expect(deps.observability.getInvocations().find((item) => item.modelId === reviewer.id)?.status).toBe('success');
      expect(growth).toHaveBeenCalledOnce();
      expect(growth).toHaveBeenCalledWith(expect.objectContaining({ modelId: lead.id, success: true, completed: true }));
      expect(events.some((event) => event.channel === 'session:agent-update' && event.payload.status === 'failed' && event.payload.stopReason === 'tool_limit' && event.payload.error.includes('部分完成'))).toBe(true);
    } finally { cleanup(); }
  });

  it('runs a simple turn and emits completion with a trace', async () => {
    const { deps, traceStore, cleanup } = makeDeps([model('m1')], async (current, _prompt, _max, onDelta) => {
      onDelta('hello');
      return { content: 'hello', inputTokens: 10, outputTokens: 5, modelId: current.id };
    });
    const events: Array<{ channel: string; payload: any }> = [];
    try {
      const output = await executeRun({
        sessionId: 'session-1', taskId: 'session-1', runId: 'run-1', assistantMessageId: 'a-1',
        prompt: 'hello', includeProjectContext: false, enableTools: false, history: [],
      }, deps, (channel, payload) => events.push({ channel, payload }));
      expect(output).toMatchObject({ output: 'hello', runId: 'run-1' });
      expect(events.some((event) => event.channel === 'session:completed')).toBe(true);
      const trace = traceStore.getTrace('run-1');
      expect(trace?.run.status).toBe('success');
      expect(trace?.spans.some((span) => span.kind === 'model')).toBe(true);
    } finally { cleanup(); }
  });

  it('uses a generic planner for suggestions while the routed executor synthesizes', async () => {
    const planner = model('planner', { capabilities: [{ type: 'reasoning', score: 95 }] });
    const executor = model('executor', { isPrimary: true, capabilities: [{ type: 'code', score: 95 }] });
    const reviewer = model('reviewer', { name: 'Reviewer', capabilities: [{ type: 'reasoning', score: 90 }, { type: 'code', score: 90 }] });
    const prompts: Array<{ model: string; prompt: string }> = [];
    const plan = JSON.stringify({
      mode: 'delegate', taskType: 'code', complexity: 'high', plan: 'Review the API, then rewrite the handler.',
      subagents: [{ modelId: 'reviewer', role: 'review', instruction: 'Find correctness and security issues in src/api.ts.' }], verify: false,
    });
    const { deps, traceStore, cleanup } = makeDeps([planner, reviewer, executor], async (current, prompt, _max, onDelta) => {
      prompts.push({ model: current.id, prompt });
      const content = current.id === 'reviewer' ? 'reviewer report: handlers need validation ' + 'details '.repeat(4_000) : 'final synthesized answer';
      onDelta(content);
      return { content, inputTokens: 10, outputTokens: 5, modelId: current.id };
    }, () => ({ modelId: planner.id, invoke: async () => ({ content: plan, inputTokens: 20, outputTokens: 10, modelId: planner.id }) }));
    try {
      const output = await executeRun({
        sessionId: 'session-1', taskId: 'session-1', runId: 'run-3', assistantMessageId: 'a-3',
        prompt: 'review and fix the API', complexity: 'high', includeProjectContext: false, enableTools: false, history: [],
      }, deps, () => undefined);
      expect(output.output).toBe('final synthesized answer');
      expect(output.orchestration).toMatchObject({ orchestratorModelId: planner.id, planningModelId: planner.id, executorModelId: executor.id, synthesizerModelId: executor.id, mode: 'delegate' });
      expect((output.modelUsed as { id: string }).id).toBe(executor.id);
      expect(prompts.map((entry) => entry.model)).toEqual(['reviewer', executor.id]);
      expect(prompts[0].prompt).toContain('Find correctness and security issues');
      expect(prompts[1].prompt).toContain('reviewer report: handlers need validation');
      expect(prompts[1].prompt).toContain('附加上下文已按模型窗口截断');
      expect(Math.ceil(prompts[1].prompt.length / 4)).toBeLessThanOrEqual(1024);
      expect(output.metrics).toMatchObject({ inputTokens: 40, outputTokens: 20 });
      expect((output.metrics as { totalCost: number }).totalCost).toBeCloseTo(0.0008);
      expect(output.modelsUsed).toEqual(expect.arrayContaining([planner.id, 'reviewer', executor.id]));
      expect(traceStore.getTrace('run-3')?.spans.find((span) => span.name === 'planning')?.attributes).toMatchObject({ modelId: planner.id, executorModelId: executor.id });
    } finally { cleanup(); }
  });

  it('runs the pinned session model without semantic classification or planning', async () => {
    const deepseek = model('deepseek-chat', { provider: 'deepseek', name: 'DeepSeek Chat', capabilities: [{ type: 'reasoning', score: 95 }] });
    const reviewer = model('reviewer', { name: 'Reviewer', capabilities: [{ type: 'code', score: 90 }] });
    let calls = 0;
    const { deps, traceStore, cleanup } = makeDeps([deepseek, reviewer], async (current, _prompt, _max, onDelta) => {
      calls += 1;
      onDelta('pinned answer');
      return { content: 'pinned answer', inputTokens: 10, outputTokens: 5, modelId: current.id };
    }, () => { throw new Error('orchestrator must not run for a pinned model'); });
    const route = vi.spyOn(deps.routing, 'routeTask');
    try {
      const output = await executeRun({
        sessionId: 'session-1', taskId: 'session-1', runId: 'run-pinned', assistantMessageId: 'a-pinned',
        prompt: 'just answer with the selected model', pinnedModelId: 'reviewer', includeProjectContext: false, enableTools: false, history: [],
      }, deps, () => undefined);
      expect(output.output).toBe('pinned answer');
      expect((output.modelUsed as { id: string }).id).toBe('reviewer');
      expect(output.orchestration).toBeUndefined();
      expect(calls).toBe(1);
      expect(route).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ signal: expect.any(AbortSignal), skipSemantic: true }));
      expect(traceStore.getTrace('run-pinned')?.spans.some((span) => span.name === 'planning')).toBe(false);
    } finally { cleanup(); }
  });

  it('falls back to the next model before any output', async () => {
    const models = [model('primary'), model('fallback')];
    let calls = 0;
    const { deps, cleanup } = makeDeps(models, async (current, _prompt, _max, onDelta) => {
      calls += 1;
      if (calls === 1) throw new Error('503 upstream unavailable');
      onDelta('fallback answer');
      return { content: 'fallback answer', inputTokens: 10, outputTokens: 5, modelId: current.id };
    });
    deps.routing = new RoutingPolicyEngine(new AgentRouter(deps.models), {
      version: 1,
      rules: [{ id: 'fallback', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'primary', fallbackModelIds: ['fallback'] } }],
      defaults: { strategy: 'single' },
    });
    try {
      const output = await executeRun({
        sessionId: 'session-1', taskId: 'session-1', runId: 'run-2', assistantMessageId: 'a-2',
        prompt: 'hello', includeProjectContext: false, enableTools: false, history: [],
      }, deps, () => undefined);
      expect(output.output).toBe('fallback answer');
      expect((output.modelUsed as { id: string }).id).toBe('fallback');
      expect(calls).toBe(2);
    } finally { cleanup(); }
  });

  it('publishes actual execution identity for both failed fallback attempts before the run rejects', async () => {
    const models = [model('gpt', { name: 'GPT', modelId: 'gpt-6.1-sol' }), model('claude', { name: 'Claude', modelId: 'claude-opus-5-5' })];
    const events: Array<{ channel: string; payload: any }> = [];
    const { deps, traceStore, cleanup } = makeDeps(models, async (current, _prompt, _max, onDelta, options) => {
      if (current.id === 'gpt') throw new Error('Our servers are currently overloaded. Please try again later.');
      options!.onToolEvent?.({ toolCallId: 'read-entry', toolName: 'read', status: 'running', args: { path: 'src/main.ts' } });
      options!.onToolEvent?.({ toolCallId: 'read-entry', toolName: 'read', status: 'completed', summary: 'Read entry point' });
      onDelta('Inspecting the entry point.');
      throw new Error('Service temporarily unavailable, please retry later');
    });
    deps.routingSettings = { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'off' } };
    deps.routing = new RoutingPolicyEngine(new AgentRouter(deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [
      { id: 'fallback', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'gpt', fallbackModelIds: ['claude'] } },
    ] });
    try {
      await expect(executeRun({ sessionId: 'session-1', runId: 'failed-fallback', assistantMessageId: 'fallback-answer', prompt: 'Inspect the code', includeProjectContext: false }, deps, (channel, payload) => events.push({ channel, payload }))).rejects.toThrow('Service temporarily unavailable');
      const attempts = events.filter((event) => event.channel === 'session:model-switched' && event.payload.attempt).map((event) => event.payload);
      expect(attempts.map((event) => [event.actualModelId, event.attempt.status])).toEqual([
        ['gpt-6.1-sol', 'running'], ['gpt-6.1-sol', 'failed'], ['claude-opus-5-5', 'running'], ['claude-opus-5-5', 'failed'],
      ]);
      for (const event of attempts) expect(event).toMatchObject({ runId: 'failed-fallback', assistantMessageId: 'fallback-answer', role: 'execution', modelSnapshot: { modelId: event.actualModelId } });
      expect(attempts.at(-1)).toMatchObject({ modelId: 'claude', actualModelId: 'claude-opus-5-5', fallback: true, attempt: { error: 'Service temporarily unavailable, please retry later', durationMs: expect.any(Number), finishedAt: expect.any(String), reason: expect.stringContaining('overloaded') } });
      expect(events.find((event) => event.channel === 'session:chunk')?.payload).toMatchObject({ runId: 'failed-fallback', assistantMessageId: 'fallback-answer', modelId: 'claude', actualModelId: 'claude-opus-5-5' });
      expect(events.some((event) => event.channel === 'session:agent-update')).toBe(false);
      expect(traceStore.getTrace('failed-fallback')?.run.status).toBe('failed');
    } finally { cleanup(); }
  });

  it('emits a queued collaborator roster and returns task, timing, actual identity and tool outcomes', async () => {
    const models = [model('executor', { isPrimary: true }), model('a', { name: 'Analysis A', modelId: 'actual-a' }), model('b', { name: 'Analysis B', modelId: 'actual-b' })];
    const events: Array<{ channel: string; payload: any }> = [];
    const { deps, traceStore, cleanup } = makeDeps(models, async (current, _prompt, _max, onDelta, options) => {
      if (options?.agentId) {
        options.onToolEvent?.({ toolCallId: 'shared-tool-id', toolName: 'read', status: 'running', args: { path: current.id + '.ts' } });
        await Promise.resolve();
        options.onToolEvent?.({ toolCallId: 'shared-tool-id', toolName: 'read', status: current.id === 'a' ? 'completed' : 'failed', summary: current.id === 'a' ? 'Read module' : 'Module unavailable', durationMs: 12 });
        if (current.id === 'a') options.onToolEvent?.({ toolCallId: 'unfinished-tool', toolName: 'web_fetch', status: 'running', args: { url: 'https://example.com' } });
      }
      onDelta(current.id + ' report');
      return { content: current.id + ' report', inputTokens: 1, outputTokens: 1, modelId: current.id };
    });
    deps.routingSettings = { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'off' } };
    deps.routing = new RoutingPolicyEngine(new AgentRouter(deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [
      { id: 'parallel', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy: 'parallel', collaboratorModelIds: ['a', 'b'] } },
    ] });
    try {
      const output = await executeRun({ sessionId: 'session-1', runId: 'agents-durable', assistantMessageId: 'agents-answer', prompt: 'Compare implementation options', includeProjectContext: false }, deps, (channel, payload) => events.push({ channel, payload }));
      const lifecycle = events.filter((event) => event.channel === 'session:agent-update').map((event) => event.payload);
      expect(lifecycle.slice(0, 2).map((event) => [event.modelId, event.status])).toEqual([['a', 'queued'], ['b', 'queued']]);
      expect(lifecycle[0]).toMatchObject({ assistantMessageId: 'agents-answer', runId: 'agents-durable', actualModelId: 'actual-a', role: '方案分析', task: '独立方案与实现路径' });
      expect(lifecycle.some((event) => event.modelId === 'a' && event.status === 'running' && event.delta === 'a report')).toBe(true);
      expect(output).toMatchObject({ actualModelId: 'executor', executionAttempts: [{ status: 'completed', actualModelId: 'executor' }], agentMessages: [
        { modelId: 'a', actualModelId: 'actual-a', status: 'completed', role: '方案分析', task: '独立方案与实现路径', content: 'a report', startedAt: expect.any(String), finishedAt: expect.any(String), durationMs: expect.any(Number), tools: [
          { id: 'shared-tool-id', status: 'completed', label: 'a.ts', summary: 'Read module', durationMs: 12 },
          { id: 'unfinished-tool', status: 'failed', label: 'https://example.com' },
        ] },
        { modelId: 'b', actualModelId: 'actual-b', status: 'completed', task: '风险、限制与失败恢复', tools: [{ id: 'shared-tool-id', status: 'failed', label: 'b.ts', summary: 'Module unavailable' }] },
      ] });
      const readSpans = traceStore.getTrace('agents-durable')?.spans.filter((span) => span.name === 'read');
      expect(readSpans?.map((span) => span.status).sort()).toEqual(['failed', 'success']);
      expect(readSpans?.map((span) => span.parentSpanId)[0]).not.toBe(readSpans?.map((span) => span.parentSpanId)[1]);
    } finally { cleanup(); }
  });

  it('terminates every queued collaborator when cancellation arrives before any agent starts', async () => {
    const models = [model('executor', { isPrimary: true }), model('a'), model('b')];
    const invoke = vi.fn(async (current: ModelConfig) => ({ content: 'unused', inputTokens: 0, outputTokens: 0, modelId: current.id }));
    const { deps, cleanup } = makeDeps(models, invoke);
    deps.routingSettings = { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'off' } };
    deps.routing = new RoutingPolicyEngine(new AgentRouter(deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [
      { id: 'parallel', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy: 'parallel', collaboratorModelIds: ['a', 'b'] } },
    ] });
    const events: any[] = [];
    try {
      await expect(executeRun({ sessionId: 'session-1', runId: 'cancel-queued-agents', prompt: 'Compare options', includeProjectContext: false }, deps, (channel, payload: any) => {
        if (channel === 'session:agent-update') { events.push(payload); if (payload.status === 'queued') deps.controller.abort(); }
      })).rejects.toThrow('任务已取消');
      expect(events.map((event) => event.status)).toEqual(['queued', 'queued', 'cancelled', 'cancelled']);
      for (const event of events.filter((item) => item.status === 'cancelled')) expect(event).toMatchObject({ finishedAt: expect.any(String), durationMs: 0, error: '任务已取消' });
      expect(invoke).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('extends summaries past forty history messages and invalidates edited prefixes', async () => {
    const summarize = vi.spyOn(summaryService, 'summarizeContext').mockResolvedValue(undefined);
    const invocations: Array<Parameters<RunDependencies['invokeStreamed']>[4]> = [];
    const { deps, cleanup } = makeDeps([model('m1', { contextWindow: 10_000 })], async (current, _prompt, _max, _onDelta, options) => {
      invocations.push(options);
      return { content: 'answer', inputTokens: 10, outputTokens: 5, modelId: current.id };
    });
    const history: ContextTurn[] = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `${index === 0 ? 'EARLY_DECISION_MARKER: use pnpm' : `turn-${index}`} ${'x'.repeat(500)}`,
    }));
    const run = (turns: ContextTurn[], id: string) => executeRun({
      sessionId: 'session-1', runId: id, prompt: 'continue', pinnedModelId: 'm1',
      includeProjectContext: false, enableTools: false, history: turns,
    }, deps, () => undefined);
    try {
      await run(history, 'summary-first');
      const first = deps.summaries.getSummary('session-1')!;
      expect(first.coversTo).toBeGreaterThan(0);
      expect(first.text).toContain('EARLY_DECISION_MARKER');

      const nextHistory: ContextTurn[] = [...history,
        { role: 'user', content: `next-question ${'y'.repeat(3_000)}` },
        { role: 'assistant', content: `next-answer ${'z'.repeat(3_000)}` },
      ];
      await run(nextHistory, 'summary-extended');
      const second = deps.summaries.getSummary('session-1')!;
      expect(second.coversTo).toBeGreaterThan(first.coversTo);
      expect(second.text).toContain('EARLY_DECISION_MARKER');
      expect(invocations[1]?.summary).toContain('EARLY_DECISION_MARKER');
      expect(summarize.mock.calls[1][0]).toMatchObject({ previous: first.text });
      expect(summarize.mock.calls[1][0].turns[0].content).toBe(history[first.coversTo].content);

      const editedHistory = nextHistory.map((turn, index) => index === 0
        ? { ...turn, content: `UPDATED_DECISION_MARKER: use npm ${'x'.repeat(500)}` }
        : turn);
      await run(editedHistory, 'summary-edited');
      expect(invocations[2]?.summary).toContain('UPDATED_DECISION_MARKER');
      expect(invocations[2]?.summary).not.toContain('EARLY_DECISION_MARKER');
      expect(summarize.mock.calls[2][0].previous).toBeUndefined();
    } finally { summarize.mockRestore(); cleanup(); }
  });

  it('cancels while a project context reader is still pending', async () => {
    const invoke = vi.fn();
    const { deps, traceStore, cleanup } = makeDeps([model('m1')], invoke);
    deps.projectContext.getContextAsync = async () => new Promise(() => undefined);
    try {
      const pending = executeRun({ sessionId: 'session-1', runId: 'cancel-context', prompt: 'hello' }, deps, () => undefined);
      queueMicrotask(() => deps.controller.abort());
      await expect(pending).rejects.toThrow('任务已取消');
      expect(invoke).not.toHaveBeenCalled();
      expect(traceStore.getTrace('cancel-context')?.run.status).toBe('cancelled');
    } finally { cleanup(); }
  });

  it('returns a completed paid response as a budget-limited stage with full usage, including nonstreamed content', async () => {
    const expensive = model('m1', { costPer1kTokens: { input: 1, output: 1 } });
    const { deps, traceStore, cleanup } = makeDeps([expensive], async (current, _prompt, _max, onDelta) => {
      return { content: 'partial answer', inputTokens: 300, outputTokens: 1, modelId: current.id };
    });
    try {
      const events: Array<{ channel: string; payload: any }> = [];
      const growth = vi.spyOn(deps.growth, 'recordFeedback');
      const result = await executeRun({ sessionId: 'session-1', runId: 'cost-overrun', prompt: 'hello', includeProjectContext: false }, deps, (channel, payload) => events.push({ channel, payload }));
      expect(result).toMatchObject({ output: 'partial answer', stopReason: 'budget_limit', budgetLimit: { code: 'BUDGET_EXCEEDED', estimatedCost: 0.301, maxCostUsd: 0.25 }, metrics: { inputTokens: 300, outputTokens: 1, totalCost: 0.301, stopReason: 'budget_limit' } });
      expect(events.find((event) => event.channel === 'session:completed')?.payload).toMatchObject({ output: 'partial answer', stopReason: 'budget_limit' });
      expect(growth).not.toHaveBeenCalled();
      expect(deps.observability.getTaskMetrics('cost-overrun').totalCost).toBeCloseTo(0.301);
      expect(traceStore.getTrace('cost-overrun')?.run.status).toBe('failed');
    } finally { cleanup(); }
  });

  it('counts per-reply usage exactly once and caps the next actual request before it is sent', async () => {
    const executor = model('m1', { costPer1kTokens: { input: 1, output: 1 } });
    const invoke: RunDependencies['invokeStreamed'] = async (current, _prompt, _max, _delta, options) => {
      const cap = options!.beforeModelRequest!({ estimatedInputTokens: 50, maxOutputTokens: 1000 });
      expect(cap).toEqual({ maxOutputTokens: 200 });
      options!.onUsage!({ inputTokens: 100, outputTokens: 140, cacheReadTokens: 20 });
      expect(options!.beforeModelRequest!({ estimatedInputTokens: 2, maxOutputTokens: 100 })).toEqual({ maxOutputTokens: 8 });
      expect(() => options!.beforeModelRequest!({ estimatedInputTokens: 20, maxOutputTokens: 100 })).toThrow('剩余预估费用');
      return { content: '已检查一部分；剩余任务未完成。', inputTokens: 100, outputTokens: 140, modelId: current.id, stopReason: 'budget_limit' };
    };
    const { deps, traceStore, cleanup } = makeDeps([executor], invoke);
    try {
      const output = await executeRun({ sessionId: 'session-1', runId: 'progress-budget', prompt: 'hello', includeProjectContext: false }, deps, () => undefined);
      expect(output).toMatchObject({ stopReason: 'budget_limit', metrics: { inputTokens: 100, outputTokens: 140, totalCost: 0.24 } });
      expect(traceStore.getTrace('progress-budget')?.run).toMatchObject({ totalInputTokens: 100, totalOutputTokens: 140, totalCost: 0.24, status: 'failed' });
    } finally { cleanup(); }
  });

  it('uses a saved per-run budget and records its configured-estimate basis', async () => {
    const { deps, traceStore, cleanup } = makeDeps([model('m1', { costPer1kTokens: { input: 1, output: 1 } })], async (current) => ({ content: 'done', inputTokens: 300, outputTokens: 1, modelId: current.id, stopReason: 'stop' }));
    deps.routingSettings = { ...structuredClone(DEFAULT_ROUTING_SETTINGS), budget: { maxCostUsd: 1, maxDurationMs: 120_000 } };
    try {
      expect(await executeRun({ sessionId: 'session-1', runId: 'configured-budget', prompt: 'hello', includeProjectContext: false }, deps, () => undefined)).toMatchObject({ output: 'done', stopReason: 'stop', metrics: { totalCost: 0.301 } });
      expect(traceStore.getTrace('configured-budget')?.spans.find((span) => span.kind === 'run')?.attributes?.budget).toEqual({ maxCostUsd: 1, maxDurationMs: 120_000, pricingBasis: 'configured-token-rates' });
    } finally { cleanup(); }
  });

  it('marks length-truncated output incomplete while retaining the generated text', async () => {
    const { deps, traceStore, cleanup } = makeDeps([model('m1')], async (current) => ({ content: 'partial text', inputTokens: 10, outputTokens: 10, modelId: current.id, stopReason: 'length' }));
    const growth = vi.spyOn(deps.growth, 'recordFeedback');
    try {
      expect(await executeRun({ sessionId: 'session-1', runId: 'length-limit', prompt: 'hello', includeProjectContext: false }, deps, () => undefined)).toMatchObject({ output: 'partial text', stopReason: 'length' });
      expect(traceStore.getTrace('length-limit')?.run).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('长度上限') });
      expect(growth).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('rechecks a planned execution model after summary generation consumes its quota', async () => {
    const invoke = vi.fn();
    const summarize = vi.fn(async () => ({ content: '', inputTokens: 10, outputTokens: 0, modelId: 'm1' }));
    const limited = model('m1', { contextWindow: 10_000, rateLimit: { requestsPerMinute: 1, tokensPerDay: 100_000 } });
    const { deps, cleanup } = makeDeps([limited], invoke, () => ({ modelId: 'm1', invoke: summarize }));
    const history: ContextTurn[] = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn-${index} ${'x'.repeat(500)}` }));
    try {
      await expect(executeRun({ sessionId: 'session-1', runId: 'summary-quota', prompt: 'hello', history, includeProjectContext: false }, deps, () => undefined)).rejects.toThrow('配额');
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(invoke).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('keeps a generated summary within the assembled context budget', async () => {
    let sent: Parameters<RunDependencies['invokeStreamed']>[4];
    const { deps, cleanup } = makeDeps([model('m1', { contextWindow: 4_000, maxTokens: 2_000 }), model('summary', { contextWindow: 32_000 })], async (current, _prompt, _max, _onDelta, options) => {
      sent = options;
      return { content: 'answer', inputTokens: 10, outputTokens: 5, modelId: current.id };
    }, (current) => ({ modelId: current.id, invoke: async () => ({ content: 'Summary '.repeat(375), inputTokens: 100, outputTokens: 750, modelId: current.id }) }));
    const history: ContextTurn[] = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn-${index} ${'x'.repeat(500)}` }));
    try {
      await executeRun({ sessionId: 'session-1', runId: 'summary-budget', prompt: 'hello', pinnedModelId: 'm1', history, includeProjectContext: false }, deps, () => undefined);
      const tokens = Math.ceil((sent?.summary?.length ?? 0) / 4) + (sent?.history ?? []).reduce((sum, turn) => sum + Math.ceil(turn.content.length / 4) + 6, 0);
      expect(tokens).toBeLessThanOrEqual(1_000);
      expect(sent?.summary).toContain('Summary');
    } finally { cleanup(); }
  });

  it('reports an unavailable pinned model instead of silently switching it', async () => {
    const invoke = vi.fn();
    const { deps, cleanup } = makeDeps([model('available')], invoke);
    try {
      await expect(executeRun({ sessionId: 'session-1', prompt: 'hello', pinnedModelId: 'removed', includeProjectContext: false }, deps, () => undefined)).rejects.toThrow('固定模型当前不可用');
      expect(invoke).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it.each(['rule', 'primary'] as const)('preserves an explicit %s execution model when DeepSeek is available', async (choice) => {
    const deepseek = model('deepseek-chat', { provider: 'deepseek', capabilities: [{ type: 'reasoning', score: 95 }] });
    const selected = model('selected', { isPrimary: choice === 'primary' });
    const invoke = vi.fn(async (current: ModelConfig) => ({ content: 'selected answer', inputTokens: 10, outputTokens: 5, modelId: current.id }));
    const provider = vi.fn(() => { throw new Error('automatic orchestration must not override an explicit model'); });
    const { deps, cleanup } = makeDeps([deepseek, selected], invoke, provider);
    if (choice === 'rule') deps.routing = new RoutingPolicyEngine(new AgentRouter(deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'explicit-model', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'selected', strategy: 'single' } }] });
    try {
      const output = await executeRun({ sessionId: 'session-1', prompt: 'hello', includeProjectContext: false }, deps, () => undefined);
      expect((output.modelUsed as { id: string }).id).toBe('selected');
      expect(output.orchestration).toBeUndefined();
      expect(provider).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('budgets the task, project snapshot and history for a smaller fallback', async () => {
    const models = [model('primary', { contextWindow: 32_000 }), model('fallback', { contextWindow: 16_000 })];
    const sent: Array<{ id: string; prompt: string; max: number; options: Parameters<RunDependencies['invokeStreamed']>[4] }> = [];
    const { deps, cleanup } = makeDeps(models, async (current, prompt, max, _onDelta, options) => {
      sent.push({ id: current.id, prompt, max, options });
      if (current.id === 'primary') throw new Error('503 upstream unavailable');
      return { content: 'answer', inputTokens: 10, outputTokens: 5, modelId: current.id };
    }, (current) => ({ modelId: current.id, invoke: async () => ({ content: 'Earlier conversation checkpoint', inputTokens: 10, outputTokens: 5, modelId: current.id }) }));
    deps.routing = new RoutingPolicyEngine(new AgentRouter(deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'fallback', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'primary', fallbackModelIds: ['fallback'] } }] });
    deps.projectContext.getContextAsync = async () => ({ root: '/project', files: [], text: 'project file contents '.repeat(2_000), tokenCount: 10_500, truncated: false, skippedFiles: 0 });
    const prompt = 'Preserve this complete request, including USER_REQUIREMENT_AT_END';
    const history: ContextTurn[] = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn-${index} ${'x'.repeat(500)}` }));
    try {
      await executeRun({ sessionId: 'session-1', prompt, history }, deps, () => undefined);
      expect(sent.map((call) => call.id)).toEqual(['primary', 'fallback']);
      for (const call of sent) {
        const input = Math.ceil(call.prompt.length / 4) + Math.ceil((call.options?.summary?.length ?? 0) / 4) + (call.options?.history ?? []).reduce((sum, turn) => sum + Math.ceil(turn.content.length / 4) + 6, 0);
        expect(input + call.max + modelContextBudget(models).reserveTokens).toBeLessThanOrEqual(16_000);
        expect(call.prompt).toContain(prompt);
        expect(call.prompt).toContain('附加上下文已按模型窗口截断');
      }
    } finally { cleanup(); }
  });

  it('excludes an undersized fallback without rejecting a task the primary can fit', async () => {
    const models = [model('primary', { contextWindow: 64_000 }), model('small', { contextWindow: 8_000 })];
    const invoke = vi.fn(async (current: ModelConfig, prompt: string) => {
      expect(prompt).toContain('USER_REQUIREMENT_AT_END');
      return { content: 'answer', inputTokens: 10, outputTokens: 5, modelId: current.id };
    });
    const { deps, cleanup } = makeDeps(models, invoke);
    deps.routing = new RoutingPolicyEngine(new AgentRouter(deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'fallback', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'primary', fallbackModelIds: ['small'] } }] });
    try {
      const output = await executeRun({ sessionId: 'session-1', prompt: 'x'.repeat(40_000) + 'USER_REQUIREMENT_AT_END', includeProjectContext: false }, deps, () => undefined);
      expect((output.modelUsed as { id: string }).id).toBe('primary');
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally { cleanup(); }
  });

  it('rejects an oversized user request before invoking a model', async () => {
    const invoke = vi.fn();
    const { deps, cleanup } = makeDeps([model('m1', { contextWindow: 32_000 })], invoke);
    try {
      await expect(executeRun({ sessionId: 'session-1', prompt: 'x'.repeat(90_000), includeProjectContext: false }, deps, () => undefined)).rejects.toThrow('输入预算');
      expect(invoke).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('fits an expanded planning report before final execution', async () => {
    const models = [model('executor', { contextWindow: 4096 }), model('planner', { contextWindow: 32_000, capabilities: [{ type: 'reasoning', score: 90 }] })];
    let finalPrompt = '';
    const { deps, cleanup } = makeDeps(models, async (current, prompt) => {
      finalPrompt = prompt;
      return { content: 'answer', inputTokens: 10, outputTokens: 5, modelId: current.id };
    }, (current) => ({ modelId: current.id, invoke: async () => ({ content: JSON.stringify({ mode: 'direct', plan: 'Detailed execution plan '.repeat(2_000) }), inputTokens: 10, outputTokens: 1200, modelId: current.id }) }));
    deps.routing = new RoutingPolicyEngine(new AgentRouter(deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'selected', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy: 'plan' } }] });
    try {
      await executeRun({ sessionId: 'session-1', prompt: 'Complete USER_REQUIREMENT_AT_END', complexity: 'high', includeProjectContext: false }, deps, () => undefined);
      expect(finalPrompt).toContain('USER_REQUIREMENT_AT_END');
      expect(finalPrompt).toContain('附加上下文已按模型窗口截断');
      expect(Math.ceil(finalPrompt.length / 4)).toBeLessThanOrEqual(4_000);
    } finally { cleanup(); }
  });

  it.each([
    { strategy: 'single' as const, complexity: 'high' as const, expectedPlans: 0 },
    { strategy: 'plan' as const, complexity: 'low' as const, expectedPlans: 1 },
  ])('honors the explicit $strategy strategy at $complexity complexity', async ({ strategy, complexity, expectedPlans }) => {
    const models = [model('executor', { contextWindow: 32_000 }), model('planner', { contextWindow: 32_000, capabilities: [{ type: 'reasoning', score: 90 }] })];
    const plan = vi.fn(async () => ({ content: 'Follow the requested steps', inputTokens: 10, outputTokens: 5, modelId: 'planner' }));
    const { deps, cleanup } = makeDeps(models, async (current) => ({ content: 'answer', inputTokens: 10, outputTokens: 5, modelId: current.id }), () => ({ modelId: 'planner', invoke: plan }));
    deps.routing = new RoutingPolicyEngine(new AgentRouter(deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'strategy', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy } }] });
    try {
      await executeRun({ sessionId: 'session-1', prompt: 'hello', complexity, includeProjectContext: false }, deps, () => undefined);
      expect(plan).toHaveBeenCalledTimes(expectedPlans);
    } finally { cleanup(); }
  });

  it('does not let a DeepSeek candidate add planning or replace a simple routed task', async () => {
    const planner = model('deepseek', { provider: 'deepseek', capabilities: [{ type: 'reasoning', score: 99 }] });
    const executor = model('executor', { capabilities: [{ type: 'code', score: 99 }] });
    const provider = vi.fn(() => { throw new Error('simple tasks do not need a planner'); });
    const invoke = vi.fn(async (current: ModelConfig) => ({ content: 'done', inputTokens: 1, outputTokens: 1, modelId: current.id }));
    const { deps, cleanup } = makeDeps([planner, executor], invoke, provider);
    try {
      const output = await executeRun({ sessionId: 'session-1', prompt: 'fix this simple API bug', includeProjectContext: false }, deps, () => undefined);
      expect((output.modelUsed as { id: string }).id).toBe(executor.id);
      expect(output.planningModelId).toBeUndefined();
      expect(provider).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledOnce();
    } finally { cleanup(); }
  });

  it.each(['off', 'missing', 'disabled'] as const)('continues with its executor when planner setting is %s', async (setting) => {
    const models = [model('executor', { isPrimary: true }), model('planner', { contextWindow: 32_000, capabilities: [{ type: 'reasoning', score: 95 }] }), model('disabled', { enabled: false, capabilities: [{ type: 'reasoning', score: 99 }] })];
    const provider = vi.fn(() => { throw new Error('must not silently replace the configured planner'); });
    const { deps, cleanup } = makeDeps(models, async (current) => ({ content: 'done', inputTokens: 1, outputTokens: 1, modelId: current.id }), provider);
    deps.routingSettings = { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: setting === 'off' ? { mode: 'off' } : { mode: 'auto', modelId: setting } };
    try {
      const output = await executeRun({ sessionId: 'session-1', prompt: 'Design a system', complexity: 'high', includeProjectContext: false }, deps, () => undefined);
      expect((output.modelUsed as { id: string }).id).toBe('executor');
      expect(output.planningModelId).toBeUndefined();
      expect(provider).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('keeps explicit parallel collaborators when planning is off', async () => {
    const models = [model('executor', { isPrimary: true }), model('a'), model('b')];
    const provider = vi.fn();
    const calls: string[] = [];
    const { deps, cleanup } = makeDeps(models, async (current) => {
      calls.push(current.id);
      return { content: 'report', inputTokens: 1, outputTokens: 1, modelId: current.id };
    }, provider);
    deps.routingSettings = { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'off' } };
    deps.routing = new RoutingPolicyEngine(new AgentRouter(deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [
      { id: 'parallel', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy: 'parallel', collaboratorModelIds: ['a', 'b'] } },
    ] });
    try {
      await executeRun({ sessionId: 'session-1', prompt: 'Compare alternatives', includeProjectContext: false }, deps, () => undefined);
      expect(calls).toEqual(['a', 'b', 'executor']);
      expect(provider).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('reserves the specified planner once and keeps its suggestions from changing task classification', async () => {
    const planner = model('chosen', { contextWindow: 32_000, capabilities: [{ type: 'reasoning', score: 70 }], rateLimit: { requestsPerMinute: 1, tokensPerDay: 100_000 } });
    const strongest = model('strongest', { capabilities: [{ type: 'reasoning', score: 99 }] });
    const executor = model('executor', { isPrimary: true });
    const plan = vi.fn(async () => ({ content: JSON.stringify({ mode: 'direct', taskType: 'creative', complexity: 'low', plan: 'Inspect before implementing' }), inputTokens: 2, outputTokens: 3, modelId: planner.id }));
    const provider = vi.fn((current: ModelConfig) => ({ modelId: current.id, invoke: plan }));
    const { deps, cleanup } = makeDeps([executor, strongest, planner], async (current) => ({ content: 'done', inputTokens: 1, outputTokens: 1, modelId: current.id }), provider);
    deps.routingSettings = { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'auto', modelId: planner.id } };
    const reserve = vi.spyOn(deps.quota, 'reserve');
    try {
      const output = await executeRun({ sessionId: 'session-1', prompt: 'Implement a system', taskType: 'code', complexity: 'high', includeProjectContext: false }, deps, () => undefined);
      expect(provider).toHaveBeenCalledWith(expect.objectContaining({ id: planner.id }));
      expect(reserve.mock.calls.filter(([current]) => current.id === planner.id)).toHaveLength(1);
      expect(deps.quota.isAvailable(planner)).toBe(false);
      expect(output.decision).toMatchObject({ modelId: executor.id, taskType: 'code', complexity: 'high' });
      expect(output.planningModelId).toBe(planner.id);
    } finally { cleanup(); }
  });

  it('uses bounded prior conversation separately from the user description and records classification in trace', async () => {
    const { deps, traceStore, cleanup } = makeDeps([model('executor')], async (current) => ({ content: 'done', inputTokens: 1, outputTokens: 1, modelId: current.id }));
    const route = vi.spyOn(deps.routing, 'routeTask');
    const observe = vi.fn();
    deps.onClassification = observe;
    const history = [{ role: 'user' as const, content: 'Earlier context '.repeat(200) + 'PROJECT_CONTEXT_TAIL' }];
    try {
      const output = await executeRun({ sessionId: 'session-1', runId: 'classification-trace', prompt: 'continue', history, includeProjectContext: false }, deps, () => undefined);
      const context = route.mock.calls[0][0];
      expect(context.description).toBe('continue');
      expect(context.priorContext?.length).toBeLessThanOrEqual(250);
      expect(context.priorContext).toContain('PROJECT_CONTEXT_TAIL');
      expect(context.priorContext).toContain('[截断]');
      expect(observe).toHaveBeenCalledWith(expect.objectContaining({ runId: 'classification-trace', sessionId: 'session-1', description: 'continue', priorContext: context.priorContext, classification: (output.decision as { classification: unknown }).classification }));
      expect(traceStore.getTrace('classification-trace')?.spans.find((span) => span.name === 'route')?.attributes?.classification).toEqual((output.decision as { classification: unknown }).classification);
    } finally { cleanup(); }
  });

  it('uses the latest second-option exchange instead of an older stored summary for classification and feedback', async () => {
    const { deps, cleanup } = makeDeps([model('executor', { contextWindow: 128_000 })], async (current) => ({ content: 'done', inputTokens: 1, outputTokens: 1, modelId: current.id }));
    deps.summaries.saveSummary('session-1', { text: 'OLD_SUMMARY: earlier branding discussion', coversTo: 1, tokens: 20 });
    const route = vi.spyOn(deps.routing, 'routeTask');
    const observe = vi.fn();
    deps.onClassification = observe;
    const history = [
      { role: 'user', content: '请比较第一方案和第二方案的部署方式。' },
      { role: 'assistant', content: '第一方案：本地运行。' + '说明细节。'.repeat(9000) + '第二方案：使用托管路由服务。' },
      { role: 'assistant', content: '   ' },
    ];
    try {
      await executeRun({ sessionId: 'session-1', prompt: '采用第二方案', history, includeProjectContext: false }, deps, () => undefined);
      const context = route.mock.calls[0][0];
      expect(context.description).toBe('采用第二方案');
      expect(context.priorContext?.length).toBeLessThanOrEqual(250);
      expect(context.priorContext).toContain('请比较第一方案和第二方案');
      expect(context.priorContext).toContain('第一方案：本地运行');
      expect(context.priorContext).toContain('第二方案：使用托管路由服务');
      expect(context.priorContext).toContain('[截断]');
      expect(context.priorContext).not.toContain('OLD_SUMMARY');
      expect(observe.mock.calls[0][0].priorContext).toBe(context.priorContext);
    } finally { cleanup(); }
  });

  it('uses bounded summary snippets only when there are no nonempty recent turns', async () => {
    const { deps, cleanup } = makeDeps([model('executor')], async (current) => ({ content: 'done', inputTokens: 1, outputTokens: 1, modelId: current.id }));
    deps.summaries.saveSummary('session-1', { text: 'SUMMARY_START ' + 'old details '.repeat(100) + 'SUMMARY_END', coversTo: 1, tokens: 300 });
    const route = vi.spyOn(deps.routing, 'routeTask');
    try {
      await executeRun({ sessionId: 'session-1', prompt: 'continue', history: [{ role: 'user', content: ' ' }], includeProjectContext: false }, deps, () => undefined);
      const prior = route.mock.calls[0][0].priorContext;
      expect(prior?.length).toBeLessThanOrEqual(250);
      expect(prior).toContain('SUMMARY_START');
      expect(prior).toContain('SUMMARY_END');
      expect(prior).toContain('[截断]');
    } finally { cleanup(); }
  });

  it('isolates an observation callback failure from task execution', async () => {
    const { deps, cleanup } = makeDeps([model('executor')], async (current) => ({ content: 'done', inputTokens: 1, outputTokens: 1, modelId: current.id }));
    deps.onClassification = () => { throw new Error('observation unavailable'); };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const output = await executeRun({ sessionId: 'session-1', prompt: 'hello', includeProjectContext: false }, deps, () => undefined);
      expect(output.output).toBe('done');
      expect(log).toHaveBeenCalledWith('Routing observation failed', expect.any(Error));
    } finally { log.mockRestore(); cleanup(); }
  });

  it('cancels a pending semantic route before invoking any model', async () => {
    const invoke = vi.fn();
    const { deps, traceStore, cleanup } = makeDeps([model('executor')], invoke);
    vi.spyOn(deps.routing, 'routeTask').mockImplementation(async () => new Promise(() => undefined));
    try {
      const pending = executeRun({ sessionId: 'session-1', runId: 'cancel-route', prompt: 'continue', includeProjectContext: false }, deps, () => undefined);
      queueMicrotask(() => deps.controller.abort());
      await expect(pending).rejects.toThrow('任务已取消');
      expect(invoke).not.toHaveBeenCalled();
      expect(traceStore.getTrace('cancel-route')?.run.status).toBe('cancelled');
    } finally { cleanup(); }
  });

  it('cancels a pending planner without continuing to execution', async () => {
    const invoke = vi.fn();
    let started: () => void = () => undefined;
    const planningStarted = new Promise<void>((resolve) => { started = resolve; });
    const { deps, traceStore, cleanup } = makeDeps([model('executor', { isPrimary: true }), model('planner', { contextWindow: 32_000, capabilities: [{ type: 'reasoning', score: 95 }] })], invoke, (current) => ({ modelId: current.id, invoke: async () => { started(); return new Promise(() => undefined); } }));
    try {
      const pending = executeRun({ sessionId: 'session-1', runId: 'cancel-planner', prompt: 'Design a system', complexity: 'high', includeProjectContext: false }, deps, () => undefined);
      const rejected = expect(pending).rejects.toThrow('任务已取消');
      await planningStarted;
      deps.controller.abort();
      await rejected;
      expect(invoke).not.toHaveBeenCalled();
      expect(traceStore.getTrace('cancel-planner')?.spans.find((span) => span.name === 'planning')?.status).toBe('cancelled');
    } finally { cleanup(); }
  });

  it('does not silently replace an unavailable utility model for summaries or extraction', async () => {
    const provider = vi.fn();
    const { deps, cleanup } = makeDeps([model('executor', { contextWindow: 10_000 }), model('available-utility')], async (current) => ({ content: 'done', inputTokens: 1, outputTokens: 1, modelId: current.id }), provider);
    deps.routingSettings = { ...structuredClone(DEFAULT_ROUTING_SETTINGS), utilityModelId: 'removed' };
    deps.memory.setAutoExtract(true);
    const history: ContextTurn[] = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'history '.repeat(100) }));
    try {
      await executeRun({ sessionId: 'session-1', prompt: 'continue', pinnedModelId: 'executor', history, includeProjectContext: false }, deps, () => undefined);
      expect(provider).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('plans a parallel strategy without replacing its explicitly selected collaborators', async () => {
    const models = [model('executor'), model('planner', { contextWindow: 32_000, capabilities: [{ type: 'reasoning', score: 95 }] }), model('a'), model('b'), model('suggested')];
    const calls: string[] = [];
    const plan = vi.fn(async () => ({ content: JSON.stringify({ mode: 'delegate', subagents: [{ modelId: 'suggested', instruction: 'Inspect an alternative.' }] }), inputTokens: 1, outputTokens: 1, modelId: 'planner' }));
    const { deps, cleanup } = makeDeps(models, async (current) => {
      calls.push(current.id);
      return { content: 'report', inputTokens: 1, outputTokens: 1, modelId: current.id };
    }, (current) => ({ modelId: current.id, invoke: plan }));
    deps.routing = new RoutingPolicyEngine(new AgentRouter(deps.models), { version: 1, defaults: { strategy: 'single' }, rules: [
      { id: 'parallel', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy: 'parallel', collaboratorModelIds: ['a', 'b'] } },
    ] });
    try {
      const output = await executeRun({ sessionId: 'session-1', prompt: 'Compare alternatives', includeProjectContext: false }, deps, () => undefined);
      expect(plan).toHaveBeenCalledOnce();
      expect(calls).toEqual(['a', 'b', 'executor']);
      expect(output.planningModelId).toBe('planner');
      expect(output.decision).toMatchObject({ modelId: 'executor', strategy: 'parallel', collaboratorModelIds: ['a', 'b'] });
    } finally { cleanup(); }
  });

  it.each(['invalid-json', 'undersized'] as const)('falls back to its routed executor when optional planning is %s', async (failure) => {
    const planner = model('planner', { contextWindow: failure === 'undersized' ? 1000 : 32_000, maxTokens: 1000, capabilities: [{ type: 'reasoning', score: 95 }] });
    const provider = vi.fn((current: ModelConfig) => ({ modelId: current.id, invoke: async () => ({ content: 'not a JSON plan', inputTokens: 2, outputTokens: 1, modelId: current.id }) }));
    const invoke = vi.fn(async (current: ModelConfig) => ({ content: 'done', inputTokens: 1, outputTokens: 1, modelId: current.id }));
    const { deps, traceStore, cleanup } = makeDeps([model('executor', { isPrimary: true }), planner], invoke, provider);
    try {
      const output = await executeRun({ sessionId: 'session-1', runId: 'plan-fallback', prompt: 'Plan this system', complexity: 'high', includeProjectContext: false }, deps, () => undefined);
      expect((output.modelUsed as { id: string }).id).toBe('executor');
      expect(output.orchestration).toBeUndefined();
      expect(invoke).toHaveBeenCalledOnce();
      if (failure === 'undersized') {
        expect(provider).not.toHaveBeenCalled();
        expect(traceStore.getTrace('plan-fallback')?.spans.find((span) => span.name === 'planning')?.status).toBe('failed');
      } else {
        expect(provider).toHaveBeenCalledOnce();
        expect(traceStore.getTrace('plan-fallback')?.spans.find((span) => span.name === 'planning')?.attributes).toMatchObject({ valid: false, fallback: 'normal-routing' });
      }
    } finally { cleanup(); }
  });
});


describe('run plan confirmation', () => {
  const plannedResponse = (id: string) => ({ content: JSON.stringify({ mode: 'direct', plan: 'Inspect and verify the requested files.', steps: [{ id: 'inspect', title: 'Inspect relevant files' }], verify: false }), inputTokens: 10, outputTokens: 10, modelId: id });

  it('finishes a plan-only request without execution tools or lifecycle commands', async () => {
    const invoke = vi.fn(); const lifecycle = vi.fn();
    const { deps, cleanup } = makeDeps([model('executor', { contextWindow: 32_000 })], invoke, (current) => ({ modelId: current.id, invoke: async () => plannedResponse(current.id) }));
    deps.createHookRuntime = lifecycle; deps.plans = new PlanController();
    try {
      const result = await executeRun({ sessionId: 'session-1', runId: 'only', prompt: 'Plan the implementation', planningMode: 'only', pinnedModelId: 'executor', includeProjectContext: false }, deps, () => undefined);
      expect(result.stopReason).toBe('plan_only'); expect(result.output).toContain('Inspect relevant files');
      expect(invoke).not.toHaveBeenCalled(); expect(lifecycle).not.toHaveBeenCalled();
      expect(deps.plans.latest('only')).toMatchObject({ status: 'completed', executionMode: 'only' });
    } finally { cleanup(); }
  });

  it('waits for the edited version, forwards its content and tracks actual step progress', async () => {
    let notify!: (plan: RunPlan) => void; const ready = new Promise<RunPlan>((resolve) => { notify = resolve; });
    const invoke = vi.fn<RunDependencies['invokeStreamed']>(async (current, prompt, _tokens, _delta, options) => {
      expect(prompt).toContain('<approved_plan>'); expect(prompt).toContain('Inspect and verify changed files');
      expect(options?.planTool?.name).toBe('update_plan');
      await options!.planTool!.execute('plan-call', { stepId: 'inspect', status: 'done' }, undefined, undefined, {} as never);
      return { content: 'Ordinary task completed.', inputTokens: 10, outputTokens: 10, modelId: current.id };
    });
    const { deps, cleanup } = makeDeps([model('executor', { contextWindow: 32_000 })], invoke, (current) => ({ modelId: current.id, invoke: async () => plannedResponse(current.id) }));
    const plans = new PlanController(); deps.plans = plans;
    try {
      const pending = executeRun({ sessionId: 'session-1', runId: 'confirmed', prompt: 'Inspect this project', planningMode: 'confirm', includeProjectContext: false }, deps, (channel, payload) => { if (channel === 'session:plan' && (payload as RunPlan).status === 'awaiting') notify(payload as RunPlan); });
      const draft = await ready; expect(invoke).not.toHaveBeenCalled();
      const edited = plans.decide({ runId: draft.runId, version: draft.version, action: 'edit', steps: [{ id: 'inspect', title: 'Inspect and verify changed files', status: 'pending' }] });
      expect(invoke).not.toHaveBeenCalled();
      plans.decide({ runId: draft.runId, version: edited.version, action: 'approve' });
      await pending; expect(invoke).toHaveBeenCalledOnce();
      expect(plans.latest('confirmed')).toMatchObject({ version: 2, status: 'completed', plan: { steps: [{ status: 'done' }] } });
    } finally { cleanup(); }
  });

  it('cancels a waiting plan and finishes the trace without starting execution', async () => {
    let notify!: () => void; const ready = new Promise<void>((resolve) => { notify = resolve; });
    const invoke = vi.fn();
    const { deps, traceStore, cleanup } = makeDeps([model('executor', { contextWindow: 32_000 })], invoke, (current) => ({ modelId: current.id, invoke: async () => plannedResponse(current.id) }));
    deps.plans = new PlanController();
    try {
      const pending = executeRun({ sessionId: 'session-1', runId: 'cancel-confirm', prompt: 'Plan this project', planningMode: 'confirm', includeProjectContext: false }, deps, (channel) => { if (channel === 'session:plan') notify(); });
      const rejected = expect(pending).rejects.toThrow('任务已取消');
      await ready; deps.controller.abort(); await rejected;
      expect(invoke).not.toHaveBeenCalled(); expect(traceStore.getTrace('cancel-confirm')?.run.status).toBe('cancelled');
      expect(deps.plans.latest('cancel-confirm')?.status).toBe('cancelled');
    } finally { cleanup(); }
  });
});


describe('confirmation waiting budget', () => {
  it('pauses both elapsed budget and the deadline until the plan is approved', async () => {
    vi.useFakeTimers();
    let notify!: () => void; const ready = new Promise<void>((resolve) => { notify = resolve; });
    const invoke = vi.fn<RunDependencies['invokeStreamed']>(async (current) => ({ content: 'Completed after approval.', inputTokens: 1, outputTokens: 1, modelId: current.id }));
    const { deps, cleanup } = makeDeps([model('executor', { contextWindow: 32_000 })], invoke, (current) => ({ modelId: current.id, invoke: async () => ({ content: JSON.stringify({ mode: 'direct', plan: 'Inspect ordinary files.' }), inputTokens: 1, outputTokens: 1, modelId: current.id }) }));
    deps.plans = new PlanController();
    deps.routingSettings = { ...structuredClone(DEFAULT_ROUTING_SETTINGS), budget: { maxCostUsd: 1, maxDurationMs: 1000 } };
    try {
      const pending = executeRun({ sessionId: 'session-1', runId: 'paused-wait', prompt: 'Inspect project', planningMode: 'confirm', pinnedModelId: 'executor', includeProjectContext: false }, deps, (channel, payload) => { if (channel === 'session:plan' && (payload as RunPlan).status === 'awaiting') notify(); });
      await ready; await vi.advanceTimersByTimeAsync(20_000);
      expect(invoke).not.toHaveBeenCalled(); expect(deps.plans.latest('paused-wait')?.status).toBe('awaiting');
      deps.plans.decide({ runId: 'paused-wait', version: 1, action: 'approve' });
      const result = await pending; expect(result.output).toBe('Completed after approval.');
      expect(result.stopReason).not.toBe('budget_limit'); expect(invoke).toHaveBeenCalledOnce();
    } finally { cleanup(); vi.useRealTimers(); }
  });
});
