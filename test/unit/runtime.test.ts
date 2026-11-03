import { describe, expect, it } from 'vitest';
import { ModelRegistry } from '../../src/core/models/ModelRegistry';
import { AgentRouter } from '../../src/core/routing/AgentRouter';
import { ObservabilityEngine } from '../../src/core/observability/ObservabilityEngine';
import { CodeAuditor } from '../../src/core/audit/CodeAuditor';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../../src/core/audit/AuditLog';

function model(id: string, score: number, priority = 0, intelligenceScore = 70) {
  return { id, provider: 'openai' as const, name: id, apiKey: '', modelId: id, costPer1kTokens: { input: 1, output: 2 }, capabilities: [{ type: 'code' as const, score }], intelligenceScore, maxTokens: 1000, rateLimit: { requestsPerMinute: 60, tokensPerDay: 10000 }, enabled: true, priority, createdAt: new Date(), updatedAt: new Date() };
}

describe('runtime pipeline', () => {
  it('routes enabled work by capability and returns alternatives', async () => {
    const registry = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    registry.registerModel(model('strong', 95));
    registry.registerModel(model('backup', 80, 1));
    const decision = await new AgentRouter(registry).routeTask({ id: 'task', type: 'code', description: 'fix it', complexity: 'high' });
    expect(decision.modelId).toBe('strong');
    expect(decision.alternativeModels).toEqual(['backup']);
    expect(decision.estimatedCost).toBeGreaterThan(0);
  });

  it('uses the configured intelligence score to break close high-complexity matches', async () => {
    const registry = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    registry.registerModel(model('specialist', 95, 0, 40));
    registry.registerModel(model('balanced', 82, 0, 100));
    const decision = await new AgentRouter(registry).routeTask({ id: 'task', type: 'code', description: 'complex task', complexity: 'high' });
    expect(decision.modelId).toBe('balanced');
  });

  it('records invocation metrics and computes task aggregates', () => {
    const metrics = new ObservabilityEngine();
    const id = metrics.recordInvocationStart('task', 'model');
    const completed = metrics.recordInvocationEnd(id, 10, 20, { input: 0.01, output: 0.02 });
    expect(completed?.status).toBe('success');
    expect(metrics.getTaskMetrics('task')).toMatchObject({ totalInvocations: 1, totalTokens: 30, successRate: 1 });
    metrics.close();
  });

  it('flags unsafe patterns in the local audit baseline', () => {
    const result = new CodeAuditor().auditCode('const x = eval(input);', 'task', 'model');
    expect(result.approval).toBe(false);
    expect(result.issues[0]?.category).toBe('security');
    expect(result.contentHash).toHaveLength(64);
  });
});


describe('audit log', () => {
  it('appends and detects tampering in the hash chain', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-audit-'));
    const file = path.join(dir, 'audit.jsonl');
    const audit = new CodeAuditor().auditCode('const safe = 1;', 'task', 'model');
    const log = new AuditLog(file);
    log.append(audit);
    expect(log.verify()).toMatchObject({ valid: true, entries: 1 });
    fs.appendFileSync(file, '{"tampered":true}\n');
    expect(log.verify().valid).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
