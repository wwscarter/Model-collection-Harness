import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { McpTransport } from '@earendil-works/pi-mcp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/core/agent/AgentRuntime';
import { McpConfigStore } from '../../src/core/agent/McpConfigStore';
import { createConfiguredMcpTransport } from '../../src/core/agent/McpTransport';
import { SkillManager } from '../../src/core/agent/SkillManager';
import { PlanController } from '../../src/core/planning/PlanController';
import { createPlanTool } from '../../src/core/planning/planTool';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { getSandboxStatus, type SandboxMetadata } from '../../src/core/security/Sandbox';
import { configureEncryptionKeyProvider, resetEncryptionKeyProvider } from '../../src/utils/crypto';

let server: http.Server;
let baseURL = '';
const requests: any[] = [];
let replies: string[][] = [];
const cleanups: Array<() => void | Promise<void>> = [];
const nl = String.fromCharCode(10);
const sse = (chunk: object) => ['data: ' + JSON.stringify(chunk) + nl + nl, 'data: [DONE]' + nl + nl];
const text = (content: string) => sse({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
const call = () => sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'mcp__ordinary__greet', arguments: JSON.stringify({ text: 'ordinary request' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 8 } });
beforeAll(async () => {
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of replies.shift() ?? text('Ordinary task completed.')) response.write(chunk);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
});
beforeEach(() => { requests.length = 0; replies = []; configureEncryptionKeyProvider(() => Buffer.alloc(32, 6)); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); resetEncryptionKeyProvider(); });
afterAll(() => { server.closeAllConnections(); server.close(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-managed-resources-'));
  const agentDir = path.join(root, 'agent');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const model: ModelConfig = { id: 'fixture-model', name: 'Ordinary fixture', provider: 'deepseek', apiKey: 'local-fixture-only', baseURL, modelId: 'ordinary-model', enabled: true, priority: 0, maxTokens: 4_000, contextWindow: 64_000, capabilities: [], costPer1kTokens: { input: 0, output: 0 }, rateLimit: { requestsPerMinute: 60, tokensPerDay: 100_000 }, createdAt: new Date(), updatedAt: new Date() };
  return { root, agentDir, projectRoot, model };
}

// Ordinary NDJSON MCP fixture: never print environment values, only known test outcomes.
const mcpFixture = [
  "import readline from 'node:readline';",
  'const lines = readline.createInterface({ input: process.stdin });',
  "lines.on('line', (line) => {",
  '  const request = JSON.parse(line);',
  '  if (request.id === undefined) return;',
  '  let result;',
  "  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ordinary-fixture', version: '1' } };",
  "  else if (request.method === 'tools/list') result = { tools: [{ name: 'greet', description: 'Return an ordinary greeting.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };",
  "  else if (request.method === 'tools/call') {",
  "    const version = process.env.ORDINARY_LABEL === 'first synthetic label' ? 'first' : process.env.ORDINARY_LABEL === 'second synthetic label' ? 'second' : 'missing';",
  "    const keyState = process.env.AMD_ENCRYPTION_KEY === undefined ? 'app-key-absent' : 'app-key-present';",
  "    result = { content: [{ type: 'text', text: 'version=' + version + '; ' + keyState }] };",
  '  } else result = {};',
  "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + String.fromCharCode(10));",
  '});',
].join(nl);

describe('app-managed runtime resources', () => {
  it('reflects ordinary skill toggles in the next session without recreating the runtime', async () => {
    const value = fixture();
    const skillManager = new SkillManager(value.agentDir);
    const skillDir = path.join(skillManager.skillsDir, 'plain-notes');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), ['---', 'name: plain-notes', 'description: Write readable ordinary project notes.', '---', 'Use concise paragraphs.'].join(nl));
    const agent = new AgentRuntime({ agentDir: value.agentDir, defaultCwd: value.projectRoot, skillManager });
    expect((await agent.describe()).skills.map((skill) => skill.name)).toEqual(['plain-notes']);
    await agent.run({ model: value.model, prompt: 'Write ordinary notes.', projectRoot: value.projectRoot });
    expect(requests[0].messages[0].content).toContain('plain-notes');
    skillManager.setEnabled('plain-notes', false);
    expect((await agent.describe()).skills).toEqual([]);
    await agent.run({ model: value.model, prompt: 'Write ordinary notes.', projectRoot: value.projectRoot });
    expect(requests[1].messages[0].content).not.toContain('plain-notes');
    skillManager.setEnabled('plain-notes', true);
    await agent.run({ model: value.model, prompt: 'Write ordinary notes.', projectRoot: value.projectRoot });
    expect(requests[2].messages[0].content).toContain('plain-notes');
  });

  it('loads newly saved MCP config and encrypted env values in real SDK sessions', async () => {
    const value = fixture();
    const mcpConfig = new McpConfigStore(value.agentDir);
    const script = path.join(value.projectRoot, 'ordinary-mcp.mjs');
    fs.writeFileSync(script, mcpFixture);
    const transports: McpTransport[] = [];
    const sandboxes: Array<SandboxMetadata | undefined> = [];
    const previousKey = process.env.AMD_ENCRYPTION_KEY;
    process.env.AMD_ENCRYPTION_KEY = 'synthetic-app-key-fixture-only';
    cleanups.push(() => { if (previousKey === undefined) delete process.env.AMD_ENCRYPTION_KEY; else process.env.AMD_ENCRYPTION_KEY = previousKey; });
    cleanups.push(async () => { for (const transport of transports) await transport.close(); });
    const agent = new AgentRuntime({ agentDir: value.agentDir, defaultCwd: value.projectRoot, enableMcp: true, mcpConfig, mcpTransport: (entry, cwd, authProvider) => {
      const configured = createConfiguredMcpTransport({ entry, cwd, authProvider });
      transports.push(configured.transport); sandboxes.push(configured.sandbox);
      return configured.transport;
    } });
    replies = [text('No server configured yet.'), call(), text('First ordinary response.'), call(), text('Second ordinary response.'), text('Plain chat response.')];
    await agent.run({ model: value.model, prompt: 'Summarize ordinary tools.', projectRoot: value.projectRoot });
    expect(requests[0].tools.some((item: any) => item.function.name.startsWith('mcp__'))).toBe(false);
    expect(transports).toHaveLength(0);
    const config = { type: 'stdio', command: process.execPath, args: [script], exposure: 'direct', env: { ORDINARY_LABEL: 'first synthetic label' } };
    mcpConfig.save('ordinary', config);
    expect(fs.readFileSync(mcpConfig.filePath, 'utf8')).not.toContain('first synthetic label');
    const first = await agent.run({ model: value.model, prompt: 'Call the ordinary greeting tool.', projectRoot: value.projectRoot });
    expect(first).toMatchObject({ content: 'First ordinary response.', toolCalls: 1, inputTokens: 90, outputTokens: 13 });
    expect(requests[1].tools.map((item: any) => item.function.name)).toContain('mcp__ordinary__greet');
    expect(requests[2].messages.find((message: any) => message.role === 'tool').content).toContain('version=first; app-key-absent');
    mcpConfig.save('ordinary', { ...config, env: { ORDINARY_LABEL: 'second synthetic label' } });
    const second = await agent.run({ model: value.model, prompt: 'Call the updated greeting tool.', projectRoot: value.projectRoot });
    expect(second).toMatchObject({ content: 'Second ordinary response.', toolCalls: 1 });
    expect(requests[4].messages.find((message: any) => message.role === 'tool').content).toContain('version=second; app-key-absent');
    expect(transports).toHaveLength(2);
    expect(sandboxes).toEqual([expect.objectContaining({ enabled: getSandboxStatus().enabled }), expect.objectContaining({ enabled: getSandboxStatus().enabled })]);
    await agent.run({ model: value.model, prompt: 'Ordinary chat without tools.', projectRoot: value.projectRoot, enableTools: false });
    expect(transports).toHaveLength(2);
    expect(requests[5].tools ?? []).toEqual([]);
    const disk = fs.readFileSync(mcpConfig.filePath, 'utf8');
    expect(disk).not.toContain('second synthetic label');
    expect(JSON.stringify(mcpConfig.list())).not.toContain('second synthetic label');
  });
});


describe('runtime plan progress', () => {
  it('offers the run-owned progress tool and applies an ordinary SDK tool call', async () => {
    const value = fixture(); const plans = new PlanController();
    plans.create({ sessionId: 'session', runId: 'progress', assistantMessageId: 'message', executionMode: 'auto', status: 'executing', plan: { mode: 'direct', taskType: 'general', complexity: 'low', steps: [{ id: 'notes', title: 'Write readable notes', status: 'pending' }], subagents: [], verify: false } });
    replies = [sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'plan_0', type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ stepId: 'notes', status: 'done' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text('Ordinary notes completed.')];
    const runtime = new AgentRuntime({ agentDir: value.agentDir, defaultCwd: value.projectRoot });
    const result = await runtime.run({ model: value.model, prompt: 'Finish the ordinary notes step.', projectRoot: value.projectRoot, planTool: createPlanTool(plans, 'progress', () => undefined) });
    expect(requests[0].tools.map((item: any) => item.function.name)).toContain('update_plan');
    expect(result).toMatchObject({ content: 'Ordinary notes completed.', toolCalls: 1 });
    expect(plans.latest('progress')?.plan.steps[0].status).toBe('done');
  });
});
