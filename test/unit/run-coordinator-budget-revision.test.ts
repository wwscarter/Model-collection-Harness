import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeRun, type RunDependencies } from '../../src/core/agent/RunCoordinator';
import { ModelRegistry } from '../../src/core/models/ModelRegistry';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { AgentRouter } from '../../src/core/routing/AgentRouter';
import { RoutingPolicyEngine } from '../../src/core/routing/RoutingPolicy';
import { DEFAULT_ROUTING_SETTINGS } from '../../src/core/routing/RoutingSettings';
import { ModelQuota } from '../../src/core/routing/ModelQuota';
import { ObservabilityEngine } from '../../src/core/observability/ObservabilityEngine';
import { InMemoryTraceStore, TraceRecorder } from '../../src/core/trace/TraceRecorder';
import { GrowthEngine } from '../../src/core/growth/GrowthEngine';
import { MemoryStore } from '../../src/core/memory/MemoryStore';
import { SessionStorage } from '../../src/core/storage/SessionStorage';
import { CodeAuditor } from '../../src/core/audit/CodeAuditor';
import { AuditLog } from '../../src/core/audit/AuditLog';

function model(id: string): ModelConfig {
  return { id, name: id, provider: 'custom', apiKey: '', baseURL: 'http://127.0.0.1/v1', modelId: id, enabled: true, priority: 0, contextWindow: 32_000, maxTokens: 4000, capabilities: [{ type: 'code', score: 90 }], costPer1kTokens: { input: 0.01, output: 0.02 }, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 }, createdAt: new Date(), updatedAt: new Date() };
}

describe('RunCoordinator limited revision', () => {
  it.each(['budget_limit', 'tool_limit', 'length', 'failure', 'cancel'] as const)('retains paid work and accurate usage when optional processing ends with %s', async (stopReason) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-revision-budget-'));
    const original = model('executor');
    const reviser = model('reviser');
    const reviewer = model('reviewer');
    const models = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    for (const entry of [original, reviser, reviewer]) models.registerModel(entry);
    const observability = new ObservabilityEngine();
    const memory = new MemoryStore(':memory:');
    const summaries = new SessionStorage(':memory:');
    const traceStore = new InMemoryTraceStore();
    summaries.save({ id: 'session', title: 'revision', prompt: '', output: '', createdAt: new Date(), updatedAt: new Date() });
    const originalAnswer = 'Original paid answer.\n\n```ts\nconst result = eval(userInput);\n```';
    const calls: string[] = [];
    const deps: RunDependencies = {
      models, observability, quota: new ModelQuota(observability), memory, summaries, growth: new GrowthEngine(), codeAuditor: new CodeAuditor(),
      traces: new TraceRecorder(traceStore), auditLog: new AuditLog(path.join(directory, 'audit.jsonl')), controller: new AbortController(),
      projectContext: { getRoot: () => undefined, getContextAsync: async () => undefined },
      routingSettings: { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'off' }, utilityModelId: reviewer.id, ...{} },
      routing: new RoutingPolicyEngine(new AgentRouter(models), { version: 1, defaults: { strategy: 'single' }, rules: [
        { id: 'escalate', enabled: true, priority: 1, when: {}, then: { primaryModelId: original.id, strategy: 'escalate', fallbackModelIds: [reviser.id] } },
      ] }),
      invokeStreamed: async (current, _prompt, _maxTokens, _onDelta, options) => {
        calls.push(current.id);
        const usage = current.id === original.id ? { inputTokens: 100, outputTokens: 20 } : { inputTokens: 30, outputTokens: 5 };
        options?.onUsage?.(usage);
        if (current.id === reviser.id && stopReason === 'failure') throw new Error('revision provider failed');
        return { content: current.id === original.id ? originalAnswer : '预算已到，未生成修订答案。', ...usage, modelId: current.id, stopReason: current.id === original.id ? 'stop' : stopReason };
      },
      createProvider: (current) => ({ modelId: current.id, invoke: async (_prompt, options) => {
        if (stopReason === 'cancel') deps.controller.abort();
        if (stopReason === 'cancel') {
          return await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(options?.signal?.reason ?? new Error('cancelled'));
            options?.signal?.addEventListener('abort', abort, { once: true });
            if (options?.signal?.aborted) abort();
          });
        }
        return { content: JSON.stringify({ issues: [{ severity: 'high', category: 'security', description: 'Untrusted eval', suggestion: 'Remove eval' }], overallScore: 40, approval: false }), inputTokens: 50, outputTokens: 10, modelId: current.id };
      } }),
    };
    try {
      const pending = executeRun({ sessionId: 'session', runId: 'revision-' + stopReason, prompt: 'Fix the implementation', includeProjectContext: false }, deps, () => undefined);
      if (stopReason === 'cancel') {
        await expect(pending).rejects.toThrow('任务已取消');
        expect(calls).toEqual([original.id]);
        expect(traceStore.getTrace('revision-' + stopReason)?.run).toMatchObject({ status: 'cancelled', totalInputTokens: 100, totalOutputTokens: 20, totalCost: expect.closeTo(0.0014, 8) });
        return;
      }
      const output = await pending;
      expect(calls).toEqual([original.id, reviser.id]);
      const expectedStop = stopReason === 'failure' ? 'stop' : stopReason;
      expect(output).toMatchObject({ output: originalAnswer, stopReason: expectedStop, modelUsed: { id: original.id }, verification: { revised: false }, metrics: { inputTokens: 180, outputTokens: 35, totalCost: expect.closeTo(0.0025, 8), stopReason: expectedStop } });
      if (stopReason === 'budget_limit') expect(output).toMatchObject({ budgetLimit: { code: 'BUDGET_EXCEEDED' } });
      expect(traceStore.getTrace('revision-' + stopReason)?.run).toMatchObject({ status: stopReason === 'failure' ? 'success' : 'failed', totalInputTokens: 180, totalOutputTokens: 35, totalCost: expect.closeTo(0.0025, 8) });
      expect(traceStore.getTrace('revision-' + stopReason)?.spans.find((span) => span.name === 'revision')).toMatchObject({ status: 'failed', modelId: reviser.id, inputTokens: 30, outputTokens: 5, ...(stopReason === 'failure' ? { errorMessage: 'revision provider failed' } : { attributes: { stopReason, retainedOriginalAnswer: true } }) });
      expect(observability.getTaskMetrics('revision-' + stopReason).totalCost).toBeCloseTo(0.0025);
    } finally { observability.close(); memory.close(); summaries.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
