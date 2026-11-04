import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/core/memory/MemoryStore';
import { retrieveMemories } from '../../src/core/memory/MemoryRetriever';

const stores: MemoryStore[] = [];
const openStore = () => { const store = new MemoryStore(':memory:'); stores.push(store); return store; };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
});

describe('memory retrieval and filtering', () => {
  it('finds project memories even when hundreds of other scope records match the search', () => {
    const store = openStore();
    for (let index = 0; index < 220; index += 1) store.add({ content: 'build', scope: 'global' });
    const project = store.add({ content: 'build', scope: 'project', projectRoot: '/project' });
    expect(store.search('build', { scopes: ['project'], projectRoot: '/project', limit: 1 }).map((record) => record.id)).toEqual([project.id]);
  });

  it('filters expired records before applying a list limit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T08:00:00Z'));
    const store = openStore();
    const active = store.add({ content: 'Current build preference' });
    vi.setSystemTime(new Date('2026-11-04T08:01:00Z'));
    store.add({ content: 'Expired build preference', expiresAt: new Date('2026-11-04T08:00:30Z') });
    expect(store.list({ limit: 1 }).map((record) => record.id)).toEqual([active.id]);
  });

  it('uses the same pending and all-status filters for search as for list', () => {
    const store = openStore();
    const pending = store.add({ content: 'build preference', status: 'pending' });
    const active = store.add({ content: 'build decision', status: 'active' });
    expect(store.search('build', { status: 'pending' }).map((record) => record.id)).toEqual([pending.id]);
    expect(store.search('build', { status: 'all' }).map((record) => record.id).sort()).toEqual([pending.id, active.id].sort());
    expect(store.search('build').map((record) => record.id)).toEqual([active.id]);
  });

  it('fills a small retrieval budget with shorter relevant records after a longer candidate does not fit', () => {
    const store = openStore();
    store.add({ content: 'pnpm ' + 'detailed preference '.repeat(50), confidence: 1 });
    const short = store.add({ content: 'Use pnpm', confidence: 0.5 });
    const result = retrieveMemories(store, { query: 'pnpm', sessionId: 's', limit: 1, tokenBudget: 60 });
    expect(result.records.map((record) => record.id)).toEqual([short.id]);
    expect(result.tokenCount).toBeLessThanOrEqual(60);
  });

  it('matches Chinese words regardless of their character offset in the query', () => {
    const store = openStore();
    const preference = store.add({ content: '使用 pnpm' });
    expect(retrieveMemories(store, { query: '请使用', sessionId: 's' }).records.map((record) => record.id)).toEqual([preference.id]);
  });
});
