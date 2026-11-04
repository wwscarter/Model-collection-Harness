import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/core/memory/MemoryStore';
import { retrieveMemories } from '../../src/core/memory/MemoryRetriever';
import { extractMemories } from '../../src/core/memory/MemoryExtractor';
import type { ModelConfig } from '../../src/core/models/ModelConfig';

describe('long-term memory', () => {
  it('stores global/project/session memories and retrieves relevant ones', () => {
    const store = new MemoryStore(':memory:');
    const global = store.add({ content: '用户偏好：提交前先运行 npm test', kind: 'preference', scope: 'global' });
    const project = store.add({ content: '这个项目使用 pnpm 管理依赖', kind: 'decision', scope: 'project', projectRoot: '/tmp/project-a' });
    store.add({ content: '另一个项目的秘密约定', kind: 'fact', scope: 'project', projectRoot: '/tmp/project-b' });
    const session = store.add({ content: '本项目决定先改 main.ts', kind: 'decision', scope: 'session', sessionId: 's1' });

    const result = retrieveMemories(store, { query: 'pnpm 项目 npm 提交', projectRoot: '/tmp/project-a', sessionId: 's1' });
    const ids = result.records.map((record) => record.id);
    expect(ids).toContain(project.id);
    expect(ids).toContain(global.id);
    expect(ids).toContain(session.id);
    expect(ids).not.toContain('missing');
    expect(result.text).toContain('<memory');
    expect(result.text).toContain('pnpm');

    const other = retrieveMemories(store, { query: '项目', projectRoot: '/tmp/project-b', sessionId: 's2' });
    expect(other.records.some((record) => record.id === project.id)).toBe(false);
    expect(other.records.some((record) => record.id === session.id)).toBe(false);
    store.close();
  });

  it('rejects secrets and respects deletion', () => {
    const store = new MemoryStore(':memory:');
    expect(() => store.add({ content: 'token: sk-abcdefghijklmnop1234' })).toThrow(/密钥/);
    const record = store.add({ content: '使用 TypeScript strict 模式', kind: 'fact' });
    expect(store.list()).toHaveLength(1);
    expect(store.remove(record.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    store.close();
  });

  it('searches with FTS and supports export/clear', () => {
    const store = new MemoryStore(':memory:');
    store.add({ content: '项目使用 pnpm 管理依赖', kind: 'decision', scope: 'project', projectRoot: '/p' });
    store.add({ content: '用户喜欢简洁的回答', kind: 'preference', scope: 'global' });
    expect(store.search('pnpm', { scopes: ['project'], projectRoot: '/p' })).toHaveLength(1);
    expect(store.exportAll()).toHaveLength(2);
    expect(store.clear()).toBe(2);
    expect(store.list()).toHaveLength(0);
    store.close();
  });

  it('persists the auto-extract setting and parses extracted memories', async () => {
    const store = new MemoryStore(':memory:');
    expect(store.getAutoExtract()).toBe(false);
    store.setAutoExtract(true);
    expect(store.getAutoExtract()).toBe(true);
    const model: ModelConfig = {
      id: 'm', provider: 'deepseek', name: 'm', apiKey: 'test', modelId: 'm', costPer1kTokens: { input: 0, output: 0 },
      capabilities: [], maxTokens: 1000, rateLimit: { requestsPerMinute: 1, tokensPerDay: 1000 }, enabled: true, priority: 0,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const result = await extractMemories({
      prompt: '以后都用 pnpm', answer: '好的，后续使用 pnpm。', model,
      provider: { invoke: async () => ({ content: '[{"content":"项目使用 pnpm","kind":"decision","tags":["pnpm"]}]', inputTokens: 10, outputTokens: 5, modelId: 'm' }) },
    });
    expect(result.memories).toEqual([{ content: '项目使用 pnpm', kind: 'decision', tags: ['pnpm'] }]);
    expect(result.inputTokens).toBe(10);
    store.close();
  });

  it('keeps auto-extracted memories pending until approved', () => {
    const store = new MemoryStore(':memory:');
    const pending = store.add({ content: '项目使用 pnpm', kind: 'decision', scope: 'global', status: 'pending' });
    expect(store.list()).toHaveLength(0);
    expect(store.list({ status: 'all' })).toHaveLength(1);
    expect(retrieveMemories(store, { query: 'pnpm', sessionId: 's' }).records).toHaveLength(0);
    expect(store.approve(pending.id)).toBe(true);
    expect(store.list()).toHaveLength(1);
    store.close();
  });

  it('honors the retrieval token budget', () => {
    const store = new MemoryStore(':memory:');
    for (let index = 0; index < 5; index += 1) store.add({ content: `项目规则 ${index} ${'x'.repeat(300)}`, kind: 'fact', scope: 'project', projectRoot: '/p' });
    const result = retrieveMemories(store, { query: '项目规则', projectRoot: '/p', sessionId: 's', tokenBudget: 80 });
    expect(result.tokenCount).toBeLessThanOrEqual(80);
    expect(result.records.length).toBeLessThan(5);
    store.close();
  });
});
