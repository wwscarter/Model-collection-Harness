import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime, trimHistory, type ToolEvent } from '../../src/core/agent/AgentRuntime';
import { normalizeBaseUrl, toPiModel } from '../../src/core/agent/modelMapping';
import { buildSystemPrompt } from '../../src/core/agent/systemPrompt';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { SearchProviderRegistry, type SearchProvider } from '../../src/core/tools/search';

type Reply = (body: any) => string[];
let server: http.Server;
let baseUrl = '';
const requests: any[] = [];
let replies: Reply[] = [];

const sse = (chunks: object[]) => [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'];
const text = (value: string): Reply => () => sse([{ choices: [{ index: 0, delta: { content: value }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } }]);
const toolCall = (name: string, args: object, id = 'call_1'): Reply => () => sse([
  { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking' } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args).slice(0, 5) } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(5) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 8 } },
]);

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'm-test', provider: 'deepseek', name: 'DeepSeek Test', apiKey: 'sk-test', baseURL: `${baseUrl}/v1`, modelId: 'deepseek-chat',
    enableThinking: true, temperature: 0.6, contextWindow: 64000, maxTokens: 4000, costPer1kTokens: { input: 0, output: 0 }, capabilities: [],
    rateLimit: { requestsPerMinute: 60, tokensPerDay: 1_000_000 }, enabled: true, priority: 0, createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

const fakeSearch: SearchProvider = { id: 'fake', label: 'Fake', search: async (query) => [{ title: `Result for ${query}`, url: 'https://example.com/a', snippet: '晴，20°C' }] };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push({ url: req.url, headers: req.headers, body: parsed });
      const reply = replies.shift() ?? text('fallback');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of reply(parsed)) res.write(chunk);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server.close(); });

function runtime(extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {}) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-agent-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-cwd-'));
  return { agentDir, cwd, runtime: new AgentRuntime({ agentDir, defaultCwd: cwd, search: new SearchProviderRegistry([fakeSearch]), now: () => new Date('2026-11-03T08:00:00Z'), ...extra }) };
}

describe('AgentRuntime (Pi SDK)', () => {
  it('sends tools and history, runs the tool loop and streams the final answer', async () => {
    requests.length = 0;
    replies = [toolCall('web_search', { query: '上海天气' }), text('上海今天晴，20°C。来源：https://example.com/a')];
    const { runtime: agent } = runtime();
    const deltas: string[] = [];
    const events: ToolEvent[] = [];
    const result = await agent.run({
      model: model(), prompt: '今天上海天气怎么样？',
      history: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好！' }],
      onTextDelta: (delta) => deltas.push(delta), onToolEvent: (event) => events.push(event),
    });
    expect(result.content).toContain('上海今天晴');
    expect(deltas.join('')).toContain('上海今天晴');
    expect(result.toolCalls).toBe(1);
    expect(events.map((event) => [event.toolName, event.status])).toEqual([['web_search', 'running'], ['web_search', 'completed']]);
    expect(events[1].details).toMatchObject({ provider: 'fake', query: '上海天气' });

    const first = requests[0].body;
    expect(requests[0].url).toBe('/v1/chat/completions');
    expect(requests[0].headers.authorization).toBe('Bearer sk-test');
    expect(first.tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(['web_search', 'web_fetch', 'read']));
    expect(first.messages[0].role).toBe('system');
    expect(first.messages[0].content).toContain('web_search');
    expect(first.messages[0].content).toContain('2026');
    expect(first.messages.slice(1).map((message: any) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(first.thinking).toEqual({ type: 'enabled' });

    const second = requests[1].body.messages;
    const assistant = second.find((message: any) => message.tool_calls);
    expect(assistant.reasoning_content).toBe('thinking');
    expect(assistant.tool_calls[0].function).toEqual({ name: 'web_search', arguments: JSON.stringify({ query: '上海天气' }) });
    const toolMessage = second.find((message: any) => message.role === 'tool');
    expect(toolMessage.content).toContain('Result for 上海天气');
  });

  it('sends no tools when tools are disabled', async () => {
    requests.length = 0;
    replies = [text('ok')];
    const { runtime: agent } = runtime();
    await agent.run({ model: model({ provider: 'custom', baseURL: `${baseUrl}/v1` }), prompt: 'hi', enableTools: false });
    expect(requests[0].body.tools).toBeUndefined();
    expect(requests[0].body.messages[0].content).toContain('没有可用的联网工具');
  });

  it('lets the tool gate block a call and reports the block to the model', async () => {
    requests.length = 0;
    replies = [toolCall('web_fetch', { url: 'https://example.com' }), text('无法读取')];
    const { runtime: agent } = runtime({ toolGate: ({ toolName }) => toolName === 'web_fetch' ? '用户拒绝了网页读取' : undefined });
    const events: ToolEvent[] = [];
    await agent.run({ model: model(), prompt: '读一下', onToolEvent: (event) => events.push(event) });
    expect(events.at(-1)).toMatchObject({ toolName: 'web_fetch', status: 'failed' });
    expect(requests[1].body.messages.find((message: any) => message.role === 'tool').content).toContain('用户拒绝了网页读取');
  });

  it('confines read to the project and refuses secrets', async () => {
    requests.length = 0;
    const { runtime: agent, cwd } = runtime();
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'project notes');
    fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1');
    replies = [toolCall('read', { path: 'notes.txt' }, 'c1'), toolCall('read', { path: '.env' }, 'c2'), toolCall('read', { path: '/etc/hostname' }, 'c3'), text('done')];
    const events: ToolEvent[] = [];
    await agent.run({ model: model(), prompt: '看看文件', projectRoot: cwd, onToolEvent: (event) => events.push(event) });
    const ended = events.filter((event) => event.status !== 'running');
    expect(ended.map((event) => event.status)).toEqual(['completed', 'failed', 'failed']);
    expect(ended[0].summary).toContain('project notes');
    expect(ended[1].summary).toContain('密钥');
    expect(ended[2].summary).toContain('项目目录');
  });

  it('loads skills from its own agent directory and lists them in the system prompt', async () => {
    requests.length = 0;
    replies = [text('ok')];
    const { runtime: agent, agentDir } = runtime();
    fs.mkdirSync(path.join(agentDir, 'skills', 'weekly-report'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'skills', 'weekly-report', 'SKILL.md'), '---\nname: weekly-report\ndescription: Write the weekly team report. Use when asked for a weekly summary.\n---\nUse three sections.\n');
    const summary = await agent.describe();
    expect(summary.skills.map((skill) => skill.name)).toEqual(['weekly-report']);
    await agent.run({ model: model(), prompt: '写周报' });
    expect(requests[0].body.messages[0].content).toContain('weekly-report');
  });

  it('surfaces provider errors instead of returning an empty answer', async () => {
    replies = [() => ['data: {"error":{"message":"invalid api key"}}\n\n']];
    const { runtime: agent } = runtime();
    await expect(agent.run({ model: model(), prompt: 'hi' })).rejects.toThrow();
  });
});

describe('model mapping', () => {
  it('normalizes full endpoints to the base URL Pi expects', () => {
    expect(normalizeBaseUrl('openai', 'https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('deepseek')).toBe('https://api.deepseek.com/v1');
    expect(normalizeBaseUrl('anthropic', 'https://api.anthropic.com/v1/messages')).toBe('https://api.anthropic.com');
    expect(normalizeBaseUrl('google', 'https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=x')).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(() => normalizeBaseUrl('custom', '')).toThrow();
  });

  it('maps thinking, protocol and keyless gateways', () => {
    const base = model();
    expect(toPiModel(base)).toMatchObject({ thinkingLevel: 'high', provider: { api: 'openai-completions' } });
    expect(toPiModel({ ...base, enableThinking: false }).thinkingLevel).toBe('off');
    expect(toPiModel({ ...base, provider: 'anthropic', baseURL: undefined }).provider).toMatchObject({ api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' });
    expect(toPiModel({ ...base, provider: 'custom', apiKey: '' }).apiKey).toBe('newai-no-key');
    expect(toPiModel({ ...base, id: 'a' }).providerId).not.toBe(toPiModel({ ...base, id: 'b' }).providerId);
  });
});

describe('history and prompt helpers', () => {
  it('keeps recent turns and starts on a user turn', () => {
    const history = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `m${index}` }));
    const trimmed = trimHistory(history, 5);
    expect(trimmed[0].role).toBe('user');
    expect(trimmed.at(-1)?.content).toBe('m29');
    expect(trimHistory([{ role: 'assistant', content: 'x' }])).toEqual([]);
  });

  it('states the date and the web tools', () => {
    const prompt = buildSystemPrompt({ now: new Date('2026-11-03T08:00:00Z'), tools: ['web_search', 'web_fetch'], timeZone: 'Asia/Shanghai' });
    expect(prompt).toContain('2026');
    expect(prompt).toContain('web_search');
    expect(prompt).not.toContain('没有可用的联网工具');
  });
});
