import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeRun, type RunDependencies } from '@core/agent/RunCoordinator';
import type { ModelConfig } from '@core/models/ModelConfig';
import { ModelRegistry } from '@core/models/ModelRegistry';
import { snapshotModel } from '@core/models/ModelSnapshot';
import { AgentRouter } from '@core/routing/AgentRouter';
import { RoutingPolicyEngine } from '@core/routing/RoutingPolicy';
import { ModelQuota } from '@core/routing/ModelQuota';
import { ObservabilityEngine } from '@core/observability/ObservabilityEngine';
import { InMemoryTraceStore, TraceRecorder } from '@core/trace/TraceRecorder';
import { GrowthEngine } from '@core/growth/GrowthEngine';
import { CodeAuditor } from '@core/audit/CodeAuditor';
import { AuditLog } from '@core/audit/AuditLog';
import { MemoryStore } from '@core/memory/MemoryStore';
import { SessionStorage } from '@core/storage/SessionStorage';

const model = (id: string, overrides: Partial<ModelConfig> = {}): ModelConfig => ({
  id, name: 'Display ' + id, provider: 'custom', apiKey: '', baseURL: 'http://127.0.0.1:9999/v1', modelId: 'actual-' + id,
  enabled: true, priority: 0, capabilities: [{ type: 'reasoning', score: 70 }], maxTokens: 1000, contextWindow: 8000,
  costPer1kTokens: { input: 0.001, output: 0.002 }, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100000 },
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-11-05'), ...overrides,
});

function setup(models: ModelConfig[], invokeStreamed: RunDependencies['invokeStreamed']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-trace-identity-'));
  const registry = new ModelRegistry(undefined, { initializePresets: false, persist: false });
  for (const item of models) registry.registerModel(item);
  const observability = new ObservabilityEngine();
  const store = new InMemoryTraceStore();
  const memory = new MemoryStore(':memory:');
  const summaries = new SessionStorage(':memory:');
  const deps: RunDependencies = {
    models: registry, routing: new RoutingPolicyEngine(new AgentRouter(registry)), quota: new ModelQuota(observability),
    traces: new TraceRecorder(store), observability, growth: new GrowthEngine(), codeAuditor: new CodeAuditor(),
    auditLog: new AuditLog(path.join(directory, 'audit.jsonl')), memory, summaries,
    projectContext: { getRoot: () => undefined, getContextAsync: async () => undefined }, controller: new AbortController(), invokeStreamed,
  };
  return { deps, store, cleanup: () => { observability.close(); memory.close(); summaries.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

describe('RunCoordinator trace identities and tool failures', () => {
  it('keeps the original route snapshot and attributes successful fallback usage to the actual attempted configuration', async () => {
    const primary = model('google-gemini-pro', { isPrimary: true, modelId: 'first-actual-model' });
    const fallback = model('anthropic-claude-3-sonnet', { modelId: 'fallback-actual-model' });
    const { deps, store, cleanup } = setup([primary, fallback], async (current) => {
      if (current.id === primary.id) throw new Error('primary HTTP 503 temporarily unavailable');
      return { content: 'done', inputTokens: 13, outputTokens: 5, modelId: current.id };
    });
    try {
      await executeRun({ sessionId: 's', runId: 'identity-fallback', prompt: 'hello', includeProjectContext: false, enableTools: false }, deps, () => undefined);
      const trace = store.getTrace('identity-fallback')!;
      const route = trace.spans.find((span) => span.kind === 'route')!;
      const execution = trace.spans.find((span) => span.name === 'execution')!;
      expect(route.attributes).toMatchObject({ modelSnapshot: snapshotModel(primary), fallbackSnapshots: [snapshotModel(fallback)] });
      expect(execution).toMatchObject({ modelId: fallback.id, inputTokens: 13, outputTokens: 5, attributes: { modelSnapshot: snapshotModel(fallback), attemptIndex: 1, fallbackAttempts: [primary.id], attempts: [
        { index: 0, status: 'failed', modelSnapshot: snapshotModel(primary), error: 'primary HTTP 503 temporarily unavailable' },
        { index: 1, status: 'success', modelSnapshot: snapshotModel(fallback) },
      ] } });
      expect(trace.spans.filter((span) => span.kind === 'model')).toHaveLength(1);
      expect(trace.run.totalInputTokens).toBe(13);
      expect(trace.run.totalOutputTokens).toBe(5);
      deps.models.updateModel(fallback.id, { modelId: 'edited-after-run', costPer1kTokens: { input: 10, output: 10 } });
      expect(store.getTrace('identity-fallback')?.spans.find((span) => span.name === 'execution')?.attributes?.modelSnapshot).toEqual(snapshotModel(fallback));
    } finally { cleanup(); }
  });

  it('records failed-tool summaries as short errors and labels summary size accurately', async () => {
    const summary = 'Tool denied: ' + 'details '.repeat(100);
    const { deps, store, cleanup } = setup([model('executor')], async (current, _prompt, _maxTokens, _onDelta, options) => {
      options?.onToolEvent?.({ toolCallId: 'call-1', toolName: 'read', status: 'running' });
      options?.onToolEvent?.({ toolCallId: 'call-1', toolName: 'read', status: 'failed', summary, durationMs: 5 });
      return { content: 'The read failed.', inputTokens: 10, outputTokens: 4, modelId: current.id };
    });
    try {
      await executeRun({ sessionId: 's', runId: 'tool-trace', prompt: 'hello', includeProjectContext: false }, deps, () => undefined);
      const tool = store.getTrace('tool-trace')?.spans.find((span) => span.kind === 'tool')!;
      expect(tool).toMatchObject({ status: 'failed', errorMessage: summary.slice(0, 500), attributes: { summaryChars: summary.length, durationMs: 5 } });
      expect(tool.attributes).not.toHaveProperty('resultChars');
    } finally { cleanup(); }
  });
});
