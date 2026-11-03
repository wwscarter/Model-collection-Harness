import { describe, expect, it } from 'vitest';
import { SessionStorage } from '../../src/core/storage/SessionStorage';
import { historyForModel, restoreMessages, settleAssistantTools, upsertAssistantTool, type ChatMessage } from '../../src/renderer/sessionMessages';

const pending: ChatMessage[] = [
  { id: 'u1', role: 'user', content: '今天上海天气' },
  { id: 'a1', role: 'assistant', content: '' },
];

describe('assistant tool calls', () => {
  it('adds a call when it starts and updates it in place when it ends', () => {
    let messages = upsertAssistantTool(pending, 'a1', { toolCallId: 't1', toolName: 'web_search', status: 'running', args: { query: '上海 天气' } });
    messages = upsertAssistantTool(messages, 'a1', { toolCallId: 't2', toolName: 'web_fetch', status: 'running', args: { url: 'https://example.com/' } });
    messages = upsertAssistantTool(messages, 'a1', { toolCallId: 't1', toolName: 'web_search', status: 'completed', summary: '5 条结果', durationMs: 820 });
    expect(messages[1].tools).toEqual([
      { id: 't1', toolName: 'web_search', status: 'completed', label: '上海 天气', summary: '5 条结果', durationMs: 820 },
      { id: 't2', toolName: 'web_fetch', status: 'running', label: 'https://example.com/' },
    ]);
    expect(messages[0]).toBe(pending[0]);
  });

  it('marks unfinished calls as failed when the turn ends early', () => {
    const messages = settleAssistantTools(upsertAssistantTool(pending, 'a1', { toolCallId: 't1', toolName: 'web_search', status: 'running' }), 'a1');
    expect(messages[1].tools?.[0].status).toBe('failed');
  });

  it('builds model history from non-empty turns only', () => {
    expect(historyForModel([...pending, { id: 'u2', role: 'user', content: '明天呢' }])).toEqual([
      { role: 'user', content: '今天上海天气' },
      { role: 'user', content: '明天呢' },
    ]);
  });

  it('persists tool calls and drops malformed entries', () => {
    const storage = new SessionStorage(':memory:');
    const now = new Date('2026-01-01T00:00:00.000Z');
    storage.save({ id: 's', title: 'S', prompt: '', output: '', createdAt: now, updatedAt: now, messages: [
      { id: 'u1', role: 'user', content: 'q' },
      { id: 'a1', role: 'assistant', content: 'answer', tools: [
        { id: 't1', toolName: 'web_search', status: 'completed', label: 'q', durationMs: 12 },
        { id: 't2', toolName: 'web_fetch', status: 'bogus' } as never,
      ] },
    ] });
    const loaded = storage.get('s');
    expect(loaded?.messages?.[1].tools).toEqual([{ id: 't1', toolName: 'web_search', status: 'completed', label: 'q', durationMs: 12 }]);
    const restored = restoreMessages({ messages: [{ id: 'a', role: 'assistant', content: 'x', tools: [{ id: 't', toolName: 'read', status: 'running' }] }] });
    expect(restored[0].tools?.[0].status).toBe('failed');
    storage.close();
  });
});
