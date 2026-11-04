import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/core/memory/MemoryStore';
import { retrieveMemories } from '../../src/core/memory/MemoryRetriever';

describe('long-term memory', () => {
  it('stores global/project/session memories and retrieves relevant ones', () => {
    const store = new MemoryStore(':memory:');
    const global = store.add({ content: '用户偏好：提交前先运行 npm test', kind: 'preference', scope: 'global' });
    const project = store.add({ content: '这个项目使用 pnpm 管理依赖', kind: 'decision', scope: 'project', projectRoot: '/tmp/project-a' });
    store.add({ content: '另一个项目的秘密约定', kind: 'fact', scope: 'project', projectRoot: '/tmp/project-b' });
    const session = store.add({ content: '本轮决定先改 main.ts', kind: 'decision', scope: 'session', sessionId: 's1' });

    const result = retrieveMemories(store, { query: 'pnpm 依赖 项目', projectRoot: '/tmp/project-a', sessionId: 's1' });
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

  it('honors the retrieval token budget', () => {
    const store = new MemoryStore(':memory:');
    for (let index = 0; index < 5; index += 1) store.add({ content: `项目规则 ${index} ${'x'.repeat(300)}`, kind: 'fact', scope: 'project', projectRoot: '/p' });
    const result = retrieveMemories(store, { query: '项目规则', projectRoot: '/p', sessionId: 's', tokenBudget: 80 });
    expect(result.tokenCount).toBeLessThanOrEqual(80);
    expect(result.records.length).toBeLessThan(5);
    store.close();
  });
});
