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

  it('lets DeepSeek plan and delegate to a subagent before synthesizing', async () => {
    const deepseek = model('deepseek-chat', { provider: 'deepseek', name: 'DeepSeek Chat', capabilities: [{ type: 'reasoning', score: 95 }] });
    const reviewer = model('reviewer', { name: 'Reviewer', capabilities: [{ type: 'reasoning', score: 90 }, { type: 'code', score: 90 }] });
    const prompts: Array<{ model: string; prompt: string }> = [];
    const plan = JSON.stringify({
      mode: 'delegate', taskType: 'code', complexity: 'high', plan: 'Review the API, then rewrite the handler.',
      subagents: [{ modelId: 'reviewer', role: 'review', instruction: 'Find correctness and security issues in src/api.ts.' }], verify: false,
    });
    const { deps, traceStore, cleanup } = makeDeps([deepseek, reviewer], async (current, prompt, _max, onDelta) => {
      prompts.push({ model: current.id, prompt });
      const content = current.id === 'reviewer' ? 'reviewer report: handlers need validation ' + 'details '.repeat(4_000) : 'final synthesized answer';
      onDelta(content);
      return { content, inputTokens: 10, outputTokens: 5, modelId: current.id };
    }, () => ({ modelId: 'deepseek-chat', invoke: async () => ({ content: plan, inputTokens: 20, outputTokens: 10, modelId: 'deepseek-chat' }) }));
    try {
      const output = await executeRun({
        sessionId: 'session-1', taskId: 'session-1', runId: 'run-3', assistantMessageId: 'a-3',
        prompt: 'review and fix the API', includeProjectContext: false, enableTools: false, history: [],
      }, deps, () => undefined);
      expect(output.output).toBe('final synthesized answer');
      expect(output.orchestration).toMatchObject({ orchestratorModelId: 'deepseek-chat', mode: 'delegate' });
      expect(prompts.map((entry) => entry.model)).toEqual(['reviewer', 'deepseek-chat']);
      expect(prompts[0].prompt).toContain('Find correctness and security issues');
      expect(prompts[1].prompt).toContain('reviewer report: handlers need validation');
      expect(prompts[1].prompt).toContain('附加上下文已按模型窗口截断');
      expect(Math.ceil(prompts[1].prompt.length / 4)).toBeLessThanOrEqual(1024);
      expect(output.metrics).toMatchObject({ inputTokens: 40, outputTokens: 20 });
      expect((output.metrics as { totalCost: number }).totalCost).toBeCloseTo(0.0008);
      expect(output.modelsUsed).toEqual(expect.arrayContaining(['deepseek-chat', 'reviewer']));
      expect(traceStore.getTrace('run-3')?.spans.some((span) => span.name === 'orchestrator-plan')).toBe(true);
    } finally { cleanup(); }
  });

  it('runs the pinned session model without DeepSeek orchestration', async () => {
    const deepseek = model('deepseek-chat', { provider: 'deepseek', name: 'DeepSeek Chat', capabilities: [{ type: 'reasoning', score: 95 }] });
    const reviewer = model('reviewer', { name: 'Reviewer', capabilities: [{ type: 'code', score: 90 }] });
    let calls = 0;
    const { deps, traceStore, cleanup } = makeDeps([deepseek, reviewer], async (current, _prompt, _max, onDelta) => {
      calls += 1;
      onDelta('pinned answer');
      return { content: 'pinned answer', inputTokens: 10, outputTokens: 5, modelId: current.id };
    }, () => { throw new Error('orchestrator must not run for a pinned model'); });
    try {
      const output = await executeRun({
        sessionId: 'session-1', taskId: 'session-1', runId: 'run-pinned', assistantMessageId: 'a-pinned',
        prompt: 'just answer with the selected model', pinnedModelId: 'reviewer', includeProjectContext: false, enableTools: false, history: [],
      }, deps, () => undefined);
      expect(output.output).toBe('pinned answer');
      expect((output.modelUsed as { id: string }).id).toBe('reviewer');
      expect(output.orchestration).toBeUndefined();
      expect(calls).toBe(1);
      expect(traceStore.getTrace('run-pinned')?.spans.some((span) => span.name === 'orchestrator-plan')).toBe(false);
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

  it('rejects a completed invocation that exceeded the run cost budget while preserving usage', async () => {
    const expensive = model('m1', { costPer1kTokens: { input: 1, output: 1 } });
    const { deps, traceStore, cleanup } = makeDeps([expensive], async (current, _prompt, _max, onDelta) => {
      onDelta('partial answer');
      return { content: 'partial answer', inputTokens: 300, outputTokens: 1, modelId: current.id };
    });
    try {
      await expect(executeRun({ sessionId: 'session-1', runId: 'cost-overrun', prompt: 'hello', includeProjectContext: false }, deps, () => undefined)).rejects.toThrow('成本预算');
      expect(deps.observability.getTaskMetrics('cost-overrun').totalCost).toBeCloseTo(0.301);
      expect(traceStore.getTrace('cost-overrun')?.run.status).toBe('failed');
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
    const models = [model('executor', { contextWindow: 10_000 }), model('planner', { contextWindow: 32_000, capabilities: [{ type: 'reasoning', score: 90 }] })];
    let finalPrompt = '';
    const { deps, cleanup } = makeDeps(models, async (current, prompt) => {
      finalPrompt = prompt;
      return { content: 'answer', inputTokens: 10, outputTokens: 5, modelId: current.id };
    }, (current) => ({ modelId: current.id, invoke: async () => ({ content: 'Detailed execution plan '.repeat(2_000), inputTokens: 10, outputTokens: 1200, modelId: current.id }) }));
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
});
