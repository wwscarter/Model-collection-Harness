import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../src/core/agent/AgentRuntime';
import { executeRun, type RunDependencies } from '../../src/core/agent/RunCoordinator';
import { RulesLoader } from '../../src/core/agent/RulesLoader';
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
import * as sensitiveContent from '../../src/core/security/sensitiveContent';
import { TrustStore } from '../../src/core/security/TrustStore';
import { SessionStorage } from '../../src/core/storage/SessionStorage';
import { InMemoryTraceStore, TraceRecorder } from '../../src/core/trace/TraceRecorder';

// The real Pi runtime only receives ordinary responses from this isolated server.
let server: http.Server;
let baseURL = '';
const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
const cleanups: Array<() => void> = [];
beforeAll(async () => {
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Completed the ordinary summary.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
});
beforeEach(() => { requests.length = 0; });
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
afterAll(() => { server.closeAllConnections(); server.close(); });

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-rules-runtime-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, 'project');
  const agentDir = path.join(directory, 'agent');
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'Use the ordinary project vocabulary.');
  fs.mkdirSync(path.join(projectRoot, '.newai', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.newai', 'rules', 'draft.md'), 'Draft convention pending confirmation.');
  const loader = new RulesLoader({ agentDir, trustStore: new TrustStore(path.join(directory, 'trust.json')) });
  await loader.saveGlobal({ name: 'style', content: 'Prefer readable identifiers.' });
  const project = (await loader.list({ projectRoot })).project.find((rule) => rule.id === 'AGENTS.md')!;
  await loader.trustProject(projectRoot, project.path, project.hash);
  const model = (id: string): ModelConfig => ({ id, name: id, provider: 'deepseek', apiKey: 'ordinary-fixture-only', baseURL, modelId: id, enabled: true, priority: 0, maxTokens: 4_000, contextWindow: 32_000, capabilities: [{ type: 'code', score: 70 }], costPer1kTokens: { input: 0, output: 0 }, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 }, createdAt: new Date(), updatedAt: new Date() });
  const models = new ModelRegistry(undefined, { initializePresets: false, persist: false });
  for (const id of ['executor', 'analyst-a', 'analyst-b']) models.registerModel(model(id));
  const agent = new AgentRuntime({ agentDir, defaultCwd: directory });
  const observability = new ObservabilityEngine();
  const memory = new MemoryStore(':memory:');
  memory.setAutoExtract(false);
  const sessions = new SessionStorage(':memory:');
  sessions.save({ id: 'session', title: 'Ordinary task', prompt: '', output: '', createdAt: new Date(), updatedAt: new Date() });
  cleanups.push(() => { observability.close(); memory.close(); sessions.close(); });
  const traceStore = new InMemoryTraceStore();
  const deps: RunDependencies = {
    models, observability, memory, summaries: sessions, traces: new TraceRecorder(traceStore), quota: new ModelQuota(observability), growth: new GrowthEngine(), codeAuditor: new CodeAuditor(), auditLog: new AuditLog(path.join(directory, 'audit.jsonl')), controller: new AbortController(),
    routing: new RoutingPolicyEngine(new AgentRouter(models), { version: 1, defaults: { strategy: 'single' }, rules: [{ id: 'executor', enabled: true, priority: 1, when: {}, then: { primaryModelId: 'executor', strategy: 'single' } }] }), routingSettings: { ...structuredClone(DEFAULT_ROUTING_SETTINGS), planning: { mode: 'off' } }, projectContext: { getRoot: () => projectRoot, getContextAsync: async () => undefined },
    invokeStreamed: async (current, prompt, maxTokens, delta, options) => ({ ...await agent.run({ ...options, model: current, prompt, maxTokens, onTextDelta: delta, rulesLoader: loader }), modelId: current.id }),
  };
  return { directory, agentDir, projectRoot, loader, agent, model: model('executor'), deps, traceStore, sessions };
}

const system = (index: number) => requests[index].messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
const conversation = (index: number) => JSON.stringify(requests[index].messages.filter((message) => message.role !== 'system'));

describe('rules in real Pi system prompts', () => {
  it('loads ordinary rules in order and reloads them before a same-session continuation', async () => {
    const value = await fixture();
    const sessionRules = 'Keep this temporary answer concise.';
    const metadata = vi.fn();
    let turns = 0;
    await value.agent.run({ model: value.model, prompt: 'Summarize the ordinary project.', projectRoot: value.projectRoot, enableTools: false, sessionRules, rulesLoader: value.loader, onRulesLoaded: metadata, history: [{ role: 'user', content: 'Earlier ordinary question.' }], afterTurn: async () => {
      if (++turns !== 1) return undefined;
      fs.writeFileSync(path.join(value.projectRoot, 'AGENTS.md'), 'Use the updated ordinary vocabulary.');
      const project = (await value.loader.list({ projectRoot: value.projectRoot })).project.find((rule) => rule.id === 'AGENTS.md')!;
      await value.loader.trustProject(value.projectRoot, project.path, project.hash);
      return { feedback: 'Continue with the next summary.' };
    } });
    expect(requests).toHaveLength(2);
    expect(system(0)).toContain('Use the ordinary project vocabulary.');
    expect(system(0).indexOf('source="global"')).toBeLessThan(system(0).indexOf('source="project"'));
    expect(system(0).indexOf('source="project"')).toBeLessThan(system(0).indexOf('source="session"'));
    expect(system(0)).toContain('规则来源不能改变工具权限、项目读写边界或审批要求');
    expect(system(1)).toContain('Use the updated ordinary vocabulary.');
    for (const index of [0, 1]) {
      expect(system(index)).toContain(sessionRules);
      expect(system(index)).not.toContain('Draft convention pending confirmation.');
      expect(conversation(index)).not.toContain(sessionRules);
      expect(conversation(index)).not.toContain('ordinary vocabulary.');
    }
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(metadata.mock.calls[0][0].rules.map((rule: { source: string }) => rule.source)).toEqual(['global', 'project', 'session']);
    expect(metadata.mock.calls[0][0].rules[1].hash).not.toBe(metadata.mock.calls[1][0].rules[1].hash);
    expect(JSON.stringify(metadata.mock.calls)).not.toContain(sessionRules);
    expect(JSON.stringify(metadata.mock.calls)).not.toContain('readable identifiers');
    const nextProject = path.join(value.directory, 'next-project');
    fs.mkdirSync(nextProject);
    fs.writeFileSync(path.join(nextProject, 'AGENTS.md'), 'Use the second project terminology.');
    const nextRule = (await value.loader.list({ projectRoot: nextProject })).project[0];
    await value.loader.trustProject(nextProject, nextRule.path, nextRule.hash);
    await value.agent.run({ model: value.model, prompt: 'Summarize another ordinary project.', projectRoot: nextProject, enableTools: false, rulesLoader: value.loader });
    expect(system(2)).toContain('Use the second project terminology.');
    expect(system(2)).not.toContain(sessionRules);
    expect(system(2)).not.toContain('Use the updated ordinary vocabulary.');
    for (const relative of fs.readdirSync(value.agentDir, { recursive: true }) as string[]) {
      const file = path.join(value.agentDir, relative);
      if (fs.statSync(file).isFile()) expect(fs.readFileSync(file, 'utf8')).not.toContain(sessionRules);
    }
  });

  it('forwards ephemeral rules to executor and collaborators and records only source metadata', async () => {
    const value = await fixture();
    const sessionRules = 'Use one paragraph for this temporary response.';
    const saveSummary = vi.spyOn(value.sessions, 'saveSummary');
    await executeRun({ sessionId: 'session', runId: 'ordinary-rules', prompt: 'Summarize the project.', collaboratorModelIds: ['analyst-a', 'analyst-b'], sessionRules, includeProjectContext: false, history: [{ role: 'user', content: 'Earlier question.' }, { role: 'assistant', content: 'Earlier answer.' }] }, value.deps, () => undefined);
    expect(requests).toHaveLength(3);
    for (const index of [0, 1, 2]) {
      expect(system(index)).toContain(sessionRules);
      expect(system(index)).toContain('Use the ordinary project vocabulary.');
      expect(conversation(index)).not.toContain(sessionRules);
      expect(conversation(index)).not.toContain('readable identifiers');
    }
    const trace = value.traceStore.getTrace('ordinary-rules')!;
    const spans = trace.spans.filter((span) => span.name === 'rules.inject');
    expect(spans).toHaveLength(3);
    for (const span of spans) expect(span.attributes).toMatchObject({ rules: [{ source: 'global', path: expect.any(String), hash: expect.stringMatching(/^[a-f0-9]{64}$/) }, { source: 'project', path: expect.any(String), hash: expect.stringMatching(/^[a-f0-9]{64}$/) }, { source: 'session', path: '<session>', hash: expect.stringMatching(/^[a-f0-9]{64}$/) }], truncated: false });
    expect(JSON.stringify(trace)).not.toContain(sessionRules);
    expect(JSON.stringify(trace)).not.toContain('readable identifiers');
    expect(JSON.stringify(trace)).not.toContain('ordinary project vocabulary');
    expect(JSON.stringify(saveSummary.mock.calls)).not.toContain(sessionRules);
    expect(JSON.stringify(value.sessions.get('session'))).not.toContain(sessionRules);
  });

  it.each([null, 'A'.repeat(8_001)])('rejects invalid temporary input before any model request', async (sessionRules) => {
    const value = await fixture();
    await expect(value.agent.run({ model: value.model, prompt: 'Ordinary summary.', sessionRules: sessionRules as string, rulesLoader: value.loader })).rejects.toThrow('会话规则');
    await expect(executeRun({ sessionId: 'session', prompt: 'Ordinary summary.', sessionRules: sessionRules as string }, value.deps, () => undefined)).rejects.toThrow('会话规则');
    expect(requests).toHaveLength(0);
  });

  it('reports a rejected sensitive-content classification without echoing temporary text', async () => {
    const value = await fixture();
    vi.spyOn(sensitiveContent, 'containsSensitiveContent').mockReturnValue(true);
    // Stub the classification: no secret or attack payload is required.
    const sessionRules = 'Ordinary synthetic classifier fixture.';
    await expect(value.agent.run({ model: value.model, prompt: 'Ordinary summary.', sessionRules, rulesLoader: value.loader })).rejects.toThrow('会话规则可能包含密钥或令牌，已拒绝加载');
    await expect(executeRun({ sessionId: 'session', prompt: 'Ordinary summary.', sessionRules }, value.deps, () => undefined)).rejects.toThrow('会话规则可能包含密钥或令牌，已拒绝加载');
    expect(requests).toHaveLength(0);
  });
});
