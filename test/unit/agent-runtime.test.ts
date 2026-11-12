import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentRuntime, trimHistory, type ToolEvent } from '../../src/core/agent/AgentRuntime';
import { normalizeBaseUrl, toPiModel } from '../../src/core/agent/modelMapping';
import { buildSystemPrompt } from '../../src/core/agent/systemPrompt';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { SearchProviderRegistry, type SearchProvider } from '../../src/core/tools/search';
import { createProjectCommandTools } from '../../src/core/tools/projectCommandTools';
import { ProjectProcessManager, type ProjectProcessSnapshot } from '../../src/core/tty/ProjectProcessManager';
import { BudgetExceededError } from '../../src/core/routing/RunBudget';
import type { ModelUsage } from '../../src/core/routing/ModelUsage';

type Reply = (body: any) => string[] | null;
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
const anthropicReply = (tool: boolean): Reply => () => [
  ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'search_1', name: 'web_search', input: {} } : { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ query: 'release notes' }) } : { type: 'text_delta', text: 'Anthropic done' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const googleReply = (tool: boolean): Reply => () => sse([{
  candidates: [{ content: { role: 'model', parts: tool ? [{ functionCall: { name: 'web_search', args: { query: 'release notes' } } }] : [{ text: 'Google done' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 8 },
}]).slice(0, -1);

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'm-test', provider: 'deepseek', name: 'DeepSeek Test', apiKey: 'sk-test', baseURL: `${baseUrl}/v1`, modelId: 'deepseek-chat',
    enableThinking: true, temperature: 0.6, contextWindow: 64000, maxTokens: 4000, costPer1kTokens: { input: 0, output: 0 }, capabilities: [],
    rateLimit: { requestsPerMinute: 60, tokensPerDay: 1_000_000 }, enabled: true, priority: 0, createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

const fakeSearch: SearchProvider = { id: 'fake', label: 'Fake', search: async (query) => [{ title: `Result for ${query}`, url: 'https://example.com/a', snippet: '晴，20°C' }] };
const quote = (value: string) => process.platform === 'win32' ? `"${value.replaceAll('"', '""')}"` : String.fromCharCode(39) + value.replaceAll(String.fromCharCode(39), String.fromCharCode(39, 34, 39, 34, 39)) + String.fromCharCode(39);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push({ url: req.url, headers: req.headers, body: parsed });
      const reply = replies.shift() ?? text('fallback');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = reply(parsed);
      if (chunks === null) return;
      for (const chunk of chunks) res.write(chunk);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

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
    expect(first.temperature).toBe(0.6);

    const second = requests[1].body.messages;
    const assistant = second.find((message: any) => message.tool_calls);
    expect(assistant.reasoning_content).toBe('thinking');
    expect(assistant.tool_calls[0].function).toEqual({ name: 'web_search', arguments: JSON.stringify({ query: '上海天气' }) });
    const toolMessage = second.find((message: any) => message.role === 'tool');
    expect(toolMessage.content).toContain('Result for 上海天气');
  });

  it.each(['anthropic', 'google'] as const)('runs a %s tool round and preserves the configured temperature', async (provider) => {
    requests.length = 0;
    replies = provider === 'anthropic' ? [anthropicReply(true), anthropicReply(false)] : [googleReply(true), googleReply(false)];
    const { runtime: agent } = runtime();
    const events: ToolEvent[] = [];
    const result = await agent.run({
      model: model({ provider, modelId: provider === 'anthropic' ? 'claude-test' : 'gemini-test', baseURL: `${baseUrl}/v1`, temperature: 0.25 }),
      prompt: 'Find the release notes', onToolEvent: (event) => events.push(event),
    });
    expect(result.content).toContain(provider === 'anthropic' ? 'Anthropic done' : 'Google done');
    expect(result.toolCalls).toBe(1);
    expect(events.map((event) => event.status)).toEqual(['running', 'completed']);
    expect(requests).toHaveLength(2);
    if (provider === 'anthropic') {
      expect(new URL(requests[0].url, baseUrl).pathname).toBe('/v1/messages');
      expect(requests[0].body.temperature).toBe(0.25);
      expect(requests[0].body.tools.map((tool: any) => tool.name)).toContain('web_search');
      expect(requests[1].body.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'search_1' });
    } else {
      expect(requests[0].url).toContain('/v1/models/gemini-test:streamGenerateContent');
      expect(requests[0].body.generationConfig.temperature).toBe(0.25);
      expect(requests[0].body.tools[0].functionDeclarations.map((tool: any) => tool.name)).toContain('web_search');
      expect(requests[1].body.contents.at(-1).parts[0]).toHaveProperty('functionResponse');
    }
  });

  it('summarizes retained tool results without more tools at the configured round limit', async () => {
    requests.length = 0;
    replies = [toolCall('web_search', { query: 'first' }, 'c1'), toolCall('web_search', { query: 'second' }, 'c2'), text('阶段性分析：已检查两项资料，剩余内容尚未验证。')];
    const { runtime: agent } = runtime({ maxToolRounds: 2 });
    const deltas: string[] = [];
    const result = await agent.run({ model: model(), prompt: 'Search', onTextDelta: (delta) => deltas.push(delta) });
    expect(result.stopReason).toBe('tool_limit');
    expect(result.toolCalls).toBe(2);
    expect(requests).toHaveLength(3);
    expect(requests[2].body.tools ?? []).toEqual([]);
    expect(JSON.stringify(requests[2].body.messages)).toContain('Result for first');
    expect(JSON.stringify(requests[2].body.messages)).toContain('Result for second');
    expect(JSON.stringify(requests[2].body.messages)).toContain('阶段性分析');
    expect(result.content).toBe('阶段性分析：已检查两项资料，剩余内容尚未验证。');
    expect(deltas.join('')).toContain('阶段性分析');
    expect(result.inputTokens).toBe(130);
    expect(result.outputTokens).toBe(21);
  });

  it('continues automatically when the model stops at its single-response output cap', async () => {
    requests.length = 0;
    replies = [
      () => sse([{ choices: [{ index: 0, delta: { content: 'Part one.' }, finish_reason: 'length' }], usage: { prompt_tokens: 50, completion_tokens: 5 } }]),
      () => sse([{ choices: [{ index: 0, delta: { content: 'Part two.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } }]),
    ];
    const { runtime: agent } = runtime();
    const deltas: string[] = [];
    const result = await agent.run({ model: model(), prompt: 'Write a long answer', onTextDelta: (delta) => deltas.push(delta) });
    expect(result.stopReason).toBe('stop');
    expect(result.content).toBe('Part one.\n\nPart two.');
    expect(deltas.join('')).toContain('Part one.');
    expect(deltas.join('')).toContain('Part two.');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].body.messages)).toContain('上一次回答达到模型单次输出上限');
  });

  it('allows ordinary analysis to continue beyond eight tool rounds by default', async () => {
    requests.length = 0;
    replies = [...Array.from({ length: 9 }, (_, index) => toolCall('web_search', { query: `section ${index}` }, `section_${index}`)), text('项目分析完成。')];
    const { runtime: agent } = runtime();
    const result = await agent.run({ model: model(), prompt: '分析这个项目' });
    expect(result).toMatchObject({ stopReason: 'stop', toolCalls: 9, content: '项目分析完成。' });
    expect(requests).toHaveLength(10);
  });

  it.each([
    { options: { maxToolCalls: 1 }, label: 'call count' },
    { options: { maxToolResultChars: 20 }, label: 'output size' },
  ])('produces a final text-only summary when the $label budget is used', async ({ options }) => {
    requests.length = 0;
    replies = [toolCall('web_search', { query: 'project overview' }), text('阶段性分析：已获得项目概览。')];
    const { runtime: agent } = runtime(options);
    const result = await agent.run({ model: model(), prompt: 'Analyze the project' });
    expect(result).toMatchObject({ stopReason: 'tool_limit', toolCalls: 1, content: '阶段性分析：已获得项目概览。' });
    expect(requests).toHaveLength(2);
    expect(requests[1].body.tools ?? []).toEqual([]);
  });

  it('does not restart tool execution if the summary response requests another tool', async () => {
    requests.length = 0;
    const searched: string[] = [];
    const search: SearchProvider = { ...fakeSearch, search: async (query) => { searched.push(query); return fakeSearch.search(query); } };
    replies = [toolCall('web_search', { query: 'first section' }, 'c1'), toolCall('web_search', { query: 'extra section' }, 'c2')];
    const { runtime: agent } = runtime({ maxToolRounds: 1, search: new SearchProviderRegistry([search]) });
    const result = await agent.run({ model: model(), prompt: 'Analyze the project' });
    expect(requests).toHaveLength(2);
    expect(searched).toEqual(['first section']);
    expect(result).toMatchObject({ stopReason: 'tool_limit', toolCalls: 1 });
    expect(result.content).toContain('阶段总结未能生成');
    expect(result.content).toContain('first section');
  });

  it('keeps a truthful operation summary when the final summary request fails', async () => {
    requests.length = 0;
    replies = [toolCall('web_search', { query: 'read project notes' }), () => sse([{ error: { message: 'summary temporarily unavailable' } }])];
    const { runtime: agent } = runtime({ maxToolRounds: 1 });
    const result = await agent.run({ model: model(), prompt: 'Analyze the project' });
    expect(requests).toHaveLength(2);
    expect(result.stopReason).toBe('tool_limit');
    expect(result.content).toContain('本轮分析尚未完成');
    expect(result.content).toContain('read project notes');
  });

  it('honors user cancellation during the final summary request', async () => {
    requests.length = 0;
    const controller = new AbortController();
    replies = [toolCall('web_search', { query: 'overview' }), () => { setTimeout(() => controller.abort(), 20); return null; }];
    const { runtime: agent } = runtime({ maxToolRounds: 1 });
    await expect(agent.run({ model: model(), prompt: 'Analyze', signal: controller.signal })).rejects.toThrow('任务已取消');
    expect(requests).toHaveLength(2);
  });

  it('returns the final answer without retaining intermediate progress narration', async () => {
    requests.length = 0;
    replies = [
      (body) => [...sse([{ choices: [{ index: 0, delta: { content: '我先读取项目资料。' } }] }]).slice(0, -1), ...toolCall('web_search', { query: 'overview' })(body)!],
      text('项目采用模块化结构。'),
    ];
    const { runtime: agent } = runtime();
    const result = await agent.run({ model: model(), prompt: 'Analyze the project' });
    expect(result.content).toBe('项目采用模块化结构。');
  });

  it('cancels an active provider request', async () => {
    requests.length = 0;
    const controller = new AbortController();
    replies = [() => { setTimeout(() => controller.abort(), 20); return null; }];
    const { runtime: agent } = runtime();
    await expect(agent.run({ model: model(), prompt: 'Wait', signal: controller.signal })).rejects.toThrow('任务已取消');
    expect(requests).toHaveLength(1);
  });

  it('ends a provider request when the overall run deadline expires', async () => {
    requests.length = 0;
    replies = [() => null];
    const { runtime: agent } = runtime({ runTimeoutMs: 500 });
    await expect(agent.run({ model: model(), prompt: 'Wait' })).rejects.toThrow('任务执行超时');
    expect(requests).toHaveLength(1);
  });

  it('sends no tools when tools are disabled', async () => {
    requests.length = 0;
    replies = [text('ok')];
    const { runtime: agent } = runtime();
    await agent.run({ model: model({ provider: 'custom', baseURL: `${baseUrl}/v1` }), prompt: 'hi', enableTools: false });
    expect(requests[0].body.tools).toBeUndefined();
    expect(requests[0].body.messages[0].content).toContain('没有可用的联网工具');
  });

  it('includes cached prompt tokens in reported input usage', async () => {
    requests.length = 0;
    replies = [() => sse([{
      choices: [{ index: 0, delta: { content: 'cached reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } },
    }])];
    const { runtime: agent } = runtime();
    const result = await agent.run({ model: model({ provider: 'custom' }), prompt: 'hello', enableTools: false });
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(5);
  });

  it('reports each model reply once including cache splits before a later request gate', async () => {
    requests.length = 0;
    replies = [toolCall('web_search', { query: 'project overview' }), () => sse([{
      choices: [{ index: 0, delta: { content: 'final reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } },
    }])];
    const { runtime: agent } = runtime();
    const usage: ModelUsage[] = [];
    const gate = vi.fn(() => {
      if (requests.length === 1) expect(usage).toHaveLength(1);
    });
    const result = await agent.run({ model: model(), prompt: 'Analyze', onUsage: (value) => usage.push(value), beforeModelRequest: gate });
    expect(gate).toHaveBeenCalledTimes(2);
    expect(usage).toEqual([
      { inputTokens: 40, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 50, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 10 },
    ]);
    expect(result).toMatchObject({ inputTokens: 90, outputTokens: 13 });
  });

  it('caps every actual request using the SDK maxTokens option', async () => {
    requests.length = 0;
    replies = [toolCall('web_search', { query: 'project overview' }), text('final reply')];
    const { runtime: agent } = runtime();
    const gate = vi.fn(() => ({ maxOutputTokens: requests.length === 0 ? 12 : 7 }));
    await agent.run({ model: model({ provider: 'custom' }), prompt: 'Analyze', maxTokens: 100, beforeModelRequest: gate });
    expect(requests.map((entry) => entry.body.max_tokens)).toEqual([12, 7]);
    expect(gate.mock.calls.every((args) => (args as unknown[]).length === 1)).toBe(true);
  });

  it('stops before a second request and preserves streamed work without a paid summary', async () => {
    requests.length = 0;
    replies = [(body) => [...sse([{ choices: [{ index: 0, delta: { content: '已确认项目使用 TypeScript。' } }] }]).slice(0, -1), ...toolCall('web_search', { query: 'project overview' })(body)!], text('must not be requested')];
    const { runtime: agent } = runtime();
    const onUsage = vi.fn();
    let checks = 0;
    const gate = () => { if (++checks > 1) throw new BudgetExceededError('剩余预估费用不足'); };
    const result = await agent.run({ model: model(), prompt: 'Analyze', onUsage, beforeModelRequest: gate });
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ inputTokens: 40, outputTokens: 8, toolCalls: 1, stopReason: 'budget_limit' });
    expect(result.content).toContain('已确认项目使用 TypeScript');
    expect(result.content).toContain('任务尚未完成');
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it('returns an explicit partial notice when the first request cannot fit the budget', async () => {
    requests.length = 0;
    replies = [text('must not be requested')];
    const { runtime: agent } = runtime();
    const result = await agent.run({ model: model(), prompt: 'Analyze', beforeModelRequest: () => { throw new BudgetExceededError('预算不足'); } });
    expect(requests).toHaveLength(0);
    expect(result).toMatchObject({ stopReason: 'budget_limit', inputTokens: 0, outputTokens: 0, toolCalls: 0 });
    expect(result.content).toContain('预算限制停止');
  });

  it('blocks pending tools when usage accounting reaches its budget', async () => {
    requests.length = 0;
    let searches = 0;
    replies = [toolCall('web_search', { query: 'must not run' })];
    const { runtime: agent } = runtime({ search: new SearchProviderRegistry([{ ...fakeSearch, search: async (query) => { searches += 1; return fakeSearch.search(query); } }]) });
    const result = await agent.run({ model: model(), prompt: 'Analyze', onUsage: () => { throw new BudgetExceededError('实际用量达到预算'); } });
    expect(result.stopReason).toBe('budget_limit');
    expect(requests).toHaveLength(1);
    expect(searches).toBe(0);
    expect(result.inputTokens).toBe(40);
  });

  it('preserves prior usage when a model fails after a successful tool reply', async () => {
    requests.length = 0;
    replies = [toolCall('web_search', { query: 'project overview' }), () => sse([{ error: { message: 'invalid api key' } }])];
    const { runtime: agent } = runtime();
    const usage: ModelUsage[] = [];
    await expect(agent.run({ model: model(), prompt: 'Analyze', onUsage: (value) => usage.push(value) })).rejects.toThrow('invalid api key');
    expect(usage.reduce((sum, entry) => sum + entry.inputTokens, 0)).toBe(40);
    expect(requests).toHaveLength(2);
  });

  it('propagates a non-budget usage callback error without running another tool', async () => {
    requests.length = 0;
    replies = [toolCall('web_search', { query: 'must not run' })];
    let searches = 0;
    const { runtime: agent } = runtime({ search: new SearchProviderRegistry([{ ...fakeSearch, search: async (query) => { searches += 1; return fakeSearch.search(query); } }]) });
    await expect(agent.run({ model: model(), prompt: 'Analyze', onUsage: () => { throw new Error('usage persistence failed'); } })).rejects.toThrow('usage persistence failed');
    expect(searches).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it('keeps user cancellation distinct from a budget stop while preserving previous usage', async () => {
    requests.length = 0;
    const controller = new AbortController();
    replies = [toolCall('web_search', { query: 'project overview' }), () => { setTimeout(() => controller.abort(), 20); return null; }];
    const { runtime: agent } = runtime();
    const usage: ModelUsage[] = [];
    await expect(agent.run({ model: model(), prompt: 'Analyze', signal: controller.signal, onUsage: (value) => usage.push(value) })).rejects.toThrow('任务已取消');
    expect(usage.reduce((sum, entry) => sum + entry.inputTokens, 0)).toBe(40);
    expect(requests).toHaveLength(2);
  });

  it('accounts for compaction responses consumed through result without assistant message events', async () => {
    requests.length = 0;
    replies = [text('Earlier conversation summary'), text('final reply')];
    const { runtime: agent } = runtime();
    const history = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `Turn ${index}: ` + 'context '.repeat(2500) }));
    const usage: ModelUsage[] = [];
    const result = await agent.run({ model: model({ contextWindow: 32_000 }), prompt: 'Continue', history, skipHistoryTrim: true, enableTools: false, onUsage: (value) => usage.push(value) });
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(usage).toHaveLength(requests.length);
    expect(result.inputTokens).toBe(usage.reduce((sum, entry) => sum + entry.inputTokens, 0));
    expect(result.content).toBe('final reply');
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

  it('creates and edits a webpage, serves it after the run, then manages the process in the next turn', async () => {
    requests.length = 0;
    const manager = new ProjectProcessManager();
    const { runtime: agent, cwd, agentDir } = runtime({
      extraTools: ({ projectRoot }) => projectRoot ? createProjectCommandTools(projectRoot, manager) : [],
    });
    const events: ToolEvent[] = [];
    const page = '<!doctype html>\n<title>NewAi</title>\n<h1>First draft</h1>\n';
    fs.writeFileSync(path.join(cwd, 'server.cjs'), `
      const http = require('node:http');
      const fs = require('node:fs');
      const server = http.createServer((_request, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(fs.readFileSync('index.html'));
      });
      server.listen(0, '127.0.0.1', () => console.log('READY http://127.0.0.1:' + server.address().port + '/'));
    `);
    replies = [
      toolCall('write', { path: 'index.html', content: page }, 'create-page'),
      toolCall('edit', { path: 'index.html', edits: [{ oldText: '<h1>First draft</h1>', newText: '<h1>欢迎访问 NewAi</h1>' }] }, 'update-page'),
      toolCall('run_command', { command: `${quote(process.execPath)} ${quote('server.cjs')}`, background: true, timeoutMs: 500 }, 'start-page'),
      text('网页已创建并启动。'),
    ];
    try {
      const created = await agent.run({ model: model(), prompt: '创建并启动网页', projectRoot: cwd, onToolEvent: (event) => events.push(event) });
      expect(created.content).toContain('网页已创建并启动');
      expect(created.toolCalls).toBe(3);
      expect(events.filter((event) => event.status !== 'running').map((event) => [event.toolName, event.status])).toEqual([['write', 'completed'], ['edit', 'completed'], ['run_command', 'completed']]);
      expect(requests[0].body.tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(['write', 'edit', 'run_command', 'process_status', 'stop_process']));
      const startup = events.find((event) => event.toolName === 'run_command' && event.status === 'completed')?.details as ProjectProcessSnapshot;
      expect(startup).toMatchObject({ running: true, status: 'running', background: true, cwd: fs.realpathSync(cwd) });
      await vi.waitFor(() => expect(manager.status(startup.processId, cwd).urls).toHaveLength(1), { timeout: 5_000, interval: 25 });
      const started = manager.status(startup.processId, cwd);
      expect(started.urls).toHaveLength(1);
      const response = await fetch(started.urls[0]);
      expect(response.ok).toBe(true);
      expect(await response.text()).toBe(page.replace('<h1>First draft</h1>', '<h1>欢迎访问 NewAi</h1>'));
      expect(manager.status(started.processId, cwd).running).toBe(true);

      requests.length = 0;
      events.length = 0;
      replies = [
        toolCall('process_status', { processId: started.processId }, 'check-page'),
        toolCall('stop_process', { processId: started.processId }, 'stop-page'),
        text('网页服务已停止。'),
      ];
      const stopped = await agent.run({
        model: model(), prompt: '检查运行状态并停止网页服务', projectRoot: cwd,
        history: [{ role: 'user', content: '创建并启动网页' }, { role: 'assistant', content: created.content }],
        onToolEvent: (event) => events.push(event),
      });
      expect(stopped.toolCalls).toBe(2);
      expect(stopped.content).toContain('网页服务已停止');
      expect(events.find((event) => event.toolName === 'process_status' && event.status === 'completed')?.details).toMatchObject({ processId: started.processId, running: true, output: expect.stringContaining('READY') });
      expect(events.find((event) => event.toolName === 'stop_process' && event.status === 'completed')?.details).toMatchObject({ processId: started.processId, status: 'stopped', running: false });
      expect(requests[1].body.messages.find((message: any) => message.role === 'tool').content).toContain('状态：运行中');
      expect(requests[2].body.messages.filter((message: any) => message.role === 'tool').at(-1).content).toContain('状态：已停止');
      await expect(fetch(started.urls[0])).rejects.toThrow();
    } finally {
      await Promise.allSettled(manager.list().filter((process) => process.running).map((process) => manager.stop(process.processId)));
      manager.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('injects a hidden summary before recent history', async () => {
    requests.length = 0;
    replies = [text('ok')];
    const { runtime: agent } = runtime();
    await agent.run({
      model: model(), prompt: 'continue',
      summary: 'Earlier: the user chose pnpm and started the dev server.',
      history: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
    });
    const messages = requests[0].body.messages;
    const textOf = (content: any): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: any) => part?.text ?? '').join('') : '';
    const summary = messages.find((message: any) => textOf(message.content).includes('Earlier: the user chose pnpm'));
    expect(summary).toBeTruthy();
    expect(messages.map((message: any) => message.role)).toEqual(expect.arrayContaining(['user', 'assistant']));
  });

  it('offers only read tools when the caller requests read project access', async () => {
    requests.length = 0;
    replies = [text('项目只读检查完成')];
    const manager = new ProjectProcessManager();
    const { runtime: agent, cwd, agentDir } = runtime({
      extraTools: ({ projectRoot }) => projectRoot ? createProjectCommandTools(projectRoot, manager) : [],
    });
    try {
      await agent.run({ model: model(), prompt: '读取项目', projectRoot: cwd, projectAccess: 'read' });
      const names = requests[0].body.tools.map((tool: any) => tool.function.name);
      expect(names).toEqual(expect.arrayContaining(['read', 'ls', 'grep', 'find']));
      expect(requests[0].body.messages[0].content).toContain('先用 find 按文件名、grep 按内容定位');
      for (const name of ['write', 'edit', 'run_command', 'stop_process']) expect(names).not.toContain(name);
      expect(requests[0].body.messages[0].content).toContain('本轮项目文件工具只有读取能力');
    } finally {
      manager.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('returns a declined write approval to the model without creating the file', async () => {
    requests.length = 0;
    replies = [toolCall('write', { path: 'index.html', content: '<h1>NewAi</h1>' }, 'declined-write'), text('用户未批准保存网页。')];
    const approvals: Array<{ toolName: string; projectRoot?: string }> = [];
    const { runtime: agent, cwd, agentDir } = runtime({
      toolGate: (call) => {
        approvals.push(call);
        return call.toolName === 'write' ? '用户拒绝本次文件写入' : undefined;
      },
    });
    const events: ToolEvent[] = [];
    try {
      const result = await agent.run({ model: model(), prompt: '保存网页', projectRoot: cwd, onToolEvent: (event) => events.push(event) });
      expect(result.content).toContain('用户未批准保存网页');
      expect(approvals).toEqual([expect.objectContaining({ toolName: 'write', projectRoot: cwd })]);
      expect(events.at(-1)).toMatchObject({ toolName: 'write', status: 'failed', summary: expect.stringContaining('用户拒绝本次文件写入') });
      expect(requests[1].body.messages.find((message: any) => message.role === 'tool').content).toContain('用户拒绝本次文件写入');
      expect(fs.existsSync(path.join(cwd, 'index.html'))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
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

  it.each(['', '  \n '])('rejects a completed provider response containing only %j', async (content) => {
    requests.length = 0;
    replies = [text(content)];
    const { runtime: agent } = runtime();
    await expect(agent.run({ model: model({ provider: 'custom' }), prompt: 'hi', enableTools: false })).rejects.toThrow('模型返回空文本，未生成可用回答');
    expect(requests).toHaveLength(1);
  });

  it('does not treat a successful tool result as a final answer when the following response is empty', async () => {
    requests.length = 0;
    replies = [toolCall('web_search', { query: 'project overview' }), text('')];
    const { runtime: agent } = runtime();
    const events: ToolEvent[] = [];
    await expect(agent.run({ model: model(), prompt: 'Analyze the project', onToolEvent: (event) => events.push(event) })).rejects.toThrow('模型返回空文本，未生成可用回答');
    expect(requests).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ toolName: 'web_search', status: 'completed' });
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
