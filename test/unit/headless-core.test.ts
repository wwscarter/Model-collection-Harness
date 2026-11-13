import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore, type Core, type CoreApprovalRequest } from '../../src/core/bootstrap/createCore';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import type { RunDependencies } from '../../src/core/agent/RunCoordinator';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });

function directory(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-headless-')));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function model(baseURL = 'http://127.0.0.1:12345/v1'): ModelConfig {
  return { id: 'ordinary-model', name: 'Ordinary fixture', provider: 'custom', apiKey: '', baseURL, modelId: 'ordinary-fixture', enabled: true, priority: 0, maxTokens: 4_000, contextWindow: 64_000, capabilities: [{ type: 'code', score: 70 }], costPer1kTokens: { input: 0, output: 0 }, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 }, createdAt: new Date(), updatedAt: new Date() };
}
const track = (core: Core) => { cleanup.push(() => core.dispose()); return core; };
const plainReplay: RunDependencies['invokeStreamed'] = async (current, _prompt, _max, onDelta) => {
  onDelta('Ordinary response.');
  return { content: 'Ordinary response.', modelId: current.id, inputTokens: 12, outputTokens: 4 };
};

describe('headless core host', () => {
  it('preserves an explicitly empty set of enabled models across startup', async () => {
    const host = { dataDir: directory(), confirm: () => true, emit: () => undefined };
    const options = { initializePresets: false, enableMcp: false };
    const first = track(await createCore(host, { ...options, models: [model()] }));
    first.registry.updateModel(model().id, { enabled: false });
    await first.dispose();
    const next = track(await createCore(host, options));
    expect(next.registry.getEnabledModels()).toEqual([]);
  });

  it('runs real SDK file and command tools with explicit host approval and trace events', async () => {
    const root = directory();
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'notes.txt'), 'ordinary initial note');
    const requests: any[] = [];
    const replies: object[] = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'read-note', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'notes.txt' }) } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'write-note', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'result.txt', content: 'ordinary saved note' }) } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'run-note', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node -e "console.log(42)"' }) } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ index: 0, delta: { content: 'Ordinary tool workflow completed.' }, finish_reason: 'stop' }] },
    ];
    const server = http.createServer((request, response) => {
      let body = ''; request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify({ ...replies.shift(), usage: { prompt_tokens: 30, completion_tokens: 8 } }) + '\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => { server.closeAllConnections(); server.close(); });
    const approvals: CoreApprovalRequest[] = [];
    const events: Array<{ channel: string; payload: any }> = [];
    const core = track(await createCore({ dataDir: path.join(root, 'data'), confirm: (request) => { approvals.push(request); return true; }, emit: (channel, payload) => events.push({ channel, payload }) }, { initializePresets: false, models: [model('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1')], enableMcp: false }));
    const output = await core.run({ runId: 'ordinary-tools', prompt: 'Read the ordinary note, save a result note and print 42.', pinnedModelId: 'ordinary-model', includeProjectContext: false, verificationMode: 'quick' }, { projectRoot: project });
    expect(output.output).toBe('Ordinary tool workflow completed.\n\n未验证：项目未提供可运行的检查命令。');
    expect(fs.readFileSync(path.join(project, 'result.txt'), 'utf8')).toBe('ordinary saved note');
    expect(requests[1].messages.some((message: any) => message.role === 'tool' && JSON.stringify(message.content).includes('ordinary initial note'))).toBe(true);
    expect(requests[3].messages.some((message: any) => message.role === 'tool' && JSON.stringify(message.content).includes('42'))).toBe(true);
    expect(approvals.filter((request) => request.kind === 'tool').map((request) => request.toolName)).toEqual(['write', 'run_command']);
    expect(events.some((event) => event.channel === 'session:completed')).toBe(true);
    expect(core.observability.getTrace('ordinary-tools')?.run.status).toBe('success');
    expect(core.runningTasks.size).toBe(0);
  });

  it('keeps two host data directories and credential keys independent in one process', async () => {
    const root = directory();
    const host = (name: string, key: number) => ({ dataDir: path.join(root, name), secretKey: () => Buffer.alloc(32, key), confirm: () => true, emit: () => undefined });
    const first = track(await createCore(host('first', 1), { initializePresets: false, enableMcp: false, models: [{ ...model(), apiKey: 'synthetic-first-key' }] }));
    const second = track(await createCore(host('second', 2), { initializePresets: false, enableMcp: false, models: [{ ...model(), apiKey: 'synthetic-second-key' }] }));
    first.registry.updateModel('ordinary-model', { apiKey: 'synthetic-first-updated' });
    first.mcpConfig.save('ordinary', { type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: { Authorization: 'synthetic-first-header' } });
    second.mcpConfig.save('ordinary', { type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: { Authorization: 'synthetic-second-header' } });
    expect(first.storage.loadModel('ordinary-model')?.apiKey).toBe('synthetic-first-updated');
    expect(second.storage.loadModel('ordinary-model')?.apiKey).toBe('synthetic-second-key');
    expect(first.mcpConfig.load().servers[0].config).toMatchObject({ headers: { Authorization: 'synthetic-first-header' } });
    expect(second.mcpConfig.load().servers[0].config).toMatchObject({ headers: { Authorization: 'synthetic-second-header' } });
    await first.dispose(); await second.dispose();
    const reopened = track(await createCore(host('first', 1), { initializePresets: false, enableMcp: false }));
    expect(reopened.registry.getModel('ordinary-model')?.apiKey).toBe('synthetic-first-updated');
    expect(reopened.skillManager.skillsDir).toBe(path.join(root, 'first', 'agent', 'skills'));
    reopened.toolTrust.set('read', 'ask');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'first', 'agent', 'tool-trust.json'), 'utf8'))).toMatchObject({ tools: { read: 'ask' } });
  });

  it('supports an explicit replay adapter without a network request', async () => {
    const root = directory();
    const invoke = vi.fn(plainReplay);
    const core = track(await createCore({ dataDir: root, confirm: () => true, emit: () => undefined }, { initializePresets: false, models: [model()], invokeStreamed: invoke, enableMcp: false }));
    const output = await core.run({ prompt: 'Provide a short ordinary response.', pinnedModelId: 'ordinary-model', enableTools: false, includeProjectContext: false });
    expect(output.output).toBe('Ordinary response.');
    expect(invoke).toHaveBeenCalledOnce();
    expect(core.observability.getRecent(1)[0]).toMatchObject({ inputTokens: 12, outputTokens: 4, status: 'success' });
  });

  it('aborts active runs and closes managed processes when disposed', async () => {
    const root = directory();
    let notify!: () => void;
    const started = new Promise<void>((resolve) => { notify = resolve; });
    const invoke: RunDependencies['invokeStreamed'] = async (_model, _prompt, _max, _delta, options) => {
      notify();
      await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('任务已取消')), { once: true }));
      throw new Error('unreachable');
    };
    const core = track(await createCore({ dataDir: root, confirm: () => true, emit: () => undefined }, { initializePresets: false, models: [model()], invokeStreamed: invoke, enableMcp: false }));
    const service = await core.projectProcesses.run({ projectRoot: root, command: 'node -e "setInterval(() => {}, 1000)"', background: true });
    const run = core.run({ runId: 'ordinary-cancel', prompt: 'Wait for the ordinary response.', pinnedModelId: 'ordinary-model', includeProjectContext: false });
    const rejected = expect(run).rejects.toThrow('任务已取消');
    await started;
    const disposing = core.dispose();
    await rejected; await disposing;
    expect(core.runningTasks.size).toBe(0);
    expect(core.projectProcesses.status(service.id).running).toBe(false);
    await core.dispose();
    await expect(core.run({ prompt: 'Another ordinary response.' })).rejects.toThrow('Core is disposed');
  });

  it('confirms plans through the host, saves their history and skips execution in plan-only mode', async () => {
    const root = directory();
    const approvals: CoreApprovalRequest[] = [];
    const invoke = vi.fn(plainReplay);
    const core = track(await createCore({ dataDir: root, confirm: (request) => { approvals.push(request); return true; }, emit: () => undefined }, {
      models: [model()], initializePresets: false, enableMcp: false, invokeStreamed: invoke,
      createProvider: (current) => ({ modelId: current.id, invoke: async () => ({ modelId: current.id, inputTokens: 10, outputTokens: 12, content: JSON.stringify({ mode: 'direct', taskType: 'general', complexity: 'low', plan: 'Write a clear response.', steps: [{ id: 'response', title: 'Write a clear response.' }], verify: false }) }), async *invokeStream() { yield { delta: '', done: true }; } }),
    }));
    const completed = await core.run({ runId: 'confirmed-plan', sessionId: 'planned-session', prompt: 'Write an ordinary response.', pinnedModelId: 'ordinary-model', planningMode: 'confirm', includeProjectContext: false });
    expect(completed.output).toBe('Ordinary response.');
    expect(approvals.filter((request) => request.kind === 'plan')).toHaveLength(1);
    expect(core.planStorage.latest('confirmed-plan')).toMatchObject({ status: 'completed', approvedAt: expect.any(String) });
    const only = await core.run({ runId: 'only-plan', sessionId: 'planned-session', prompt: 'Plan an ordinary response.', pinnedModelId: 'ordinary-model', planningMode: 'only', includeProjectContext: false });
    expect(only.stopReason).toBe('plan_only');
    expect(invoke).toHaveBeenCalledOnce();
    expect(core.plans.list('planned-session')).toHaveLength(2);
  });
});
