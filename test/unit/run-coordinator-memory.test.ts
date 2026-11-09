import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { executeRun, type RunDependencies } from '../../src/core/agent/RunCoordinator';
import { AuditLog } from '../../src/core/audit/AuditLog';
import { CodeAuditor } from '../../src/core/audit/CodeAuditor';
import { GrowthEngine } from '../../src/core/growth/GrowthEngine';
import { MemoryStore } from '../../src/core/memory/MemoryStore';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { ModelRegistry } from '../../src/core/models/ModelRegistry';
import { ObservabilityEngine } from '../../src/core/observability/ObservabilityEngine';
import { AgentRouter } from '../../src/core/routing/AgentRouter';
import { ModelQuota } from '../../src/core/routing/ModelQuota';
import { RoutingPolicyEngine } from '../../src/core/routing/RoutingPolicy';
import { DEFAULT_ROUTING_SETTINGS } from '../../src/core/routing/RoutingSettings';
import { SessionStorage } from '../../src/core/storage/SessionStorage';
import { InMemoryTraceStore, TraceRecorder } from '../../src/core/trace/TraceRecorder';

function model(id: string): ModelConfig {
  return {
    id, name: id, provider: 'custom', apiKey: 'test', baseURL: 'http://127.0.0.1/v1', modelId: id,
    enabled: true, priority: 0, maxTokens: 4096, contextWindow: 32_000,
    capabilities: [{ type: 'code', score: 70 }], costPer1kTokens: { input: 0.01, output: 0.02 },
    rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 }, createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('RunCoordinator memory finalization', () => {
  it('retains the execution answer when an auxiliary provider returns memory JSON', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-finalize-memory-'));
    const models = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    for (const entry of [model('executor'), model('utility')]) models.registerModel(entry);
    const observability = new ObservabilityEngine();
    const memory = new MemoryStore(':memory:');
    const summaries = new SessionStorage(':memory:');
    const traceStore = new InMemoryTraceStore();
    const answer = 'The requested change is complete.';
    const memoryJson = JSON.stringify([{ content: 'Use npm for this project.', kind: 'preference', tags: ['tooling'] }]);
    const extraction = vi.fn(async () => ({ content: memoryJson, inputTokens: 7, outputTokens: 3, modelId: 'utility' }));
    const events: Array<{ channel: string; payload: unknown }> = [];
    summaries.save({ id: 'session', title: 'memory', prompt: '', output: '', createdAt: new Date(), updatedAt: new Date() });
    memory.setAutoExtract(true);
    const deps: RunDependencies = {
      models, observability, memory, summaries, traces: new TraceRecorder(traceStore),
      quota: new ModelQuota(observability), growth: new GrowthEngine(), codeAuditor: new CodeAuditor(),
      auditLog: new AuditLog(path.join(directory, 'audit.jsonl')), controller: new AbortController(),
      routing: new RoutingPolicyEngine(new AgentRouter(models), { version: 1, defaults: { strategy: 'single' }, rules: [] }),
      routingSettings: { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'off' }, utilityModelId: 'utility' },
      projectContext: { getRoot: () => undefined, getContextAsync: async () => undefined },
      invokeStreamed: async (current) => ({ content: answer, inputTokens: 12, outputTokens: 5, modelId: current.id, stopReason: 'stop' }),
      createProvider: (current) => ({ modelId: current.id, invoke: extraction }),
    };
    try {
      const result = await executeRun({ sessionId: 'session', runId: 'memory-run', prompt: 'Remember to use npm', pinnedModelId: 'executor', includeProjectContext: false }, deps, (channel, payload) => events.push({ channel, payload }));
      expect(extraction).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ output: answer, stopReason: 'stop', modelUsed: { id: 'executor' }, metrics: { inputTokens: 19, outputTokens: 8 } });
      expect(result.extractedMemoryIds).toHaveLength(1);
      expect(memory.list({ status: 'all' })).toMatchObject([{ content: 'Use npm for this project.', status: 'pending' }]);
      expect(events.find((event) => event.channel === 'session:completed')?.payload).toMatchObject({ output: answer, modelUsed: { id: 'executor' } });
      expect(traceStore.getTrace('memory-run')?.spans.find((span) => span.name === 'memory.extract')).toMatchObject({ status: 'success', inputTokens: 7, outputTokens: 3, attributes: { extracted: 1 } });
    } finally {
      observability.close();
      memory.close();
      summaries.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
