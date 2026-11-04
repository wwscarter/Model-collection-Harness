import { describe, expect, it } from 'vitest';
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
      const content = current.id === 'reviewer' ? 'reviewer report: handlers need validation' : 'final synthesized answer';
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
      expect(traceStore.getTrace('run-3')?.spans.some((span) => span.name === 'orchestrator-plan')).toBe(true);
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
});
