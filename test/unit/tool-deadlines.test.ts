import { describe, expect, it } from 'vitest';
import { BingSearchProvider } from '../../src/core/tools/search/BingSearchProvider';
import { fetchWebPage } from '../../src/core/tools/webFetch';
import { createMemoryTools } from '../../src/core/tools/memoryTools';
import { MemoryStore } from '../../src/core/memory/MemoryStore';

describe('async tool deadlines', () => {
  it('tries the next search host when a fetch implementation ignores its signal', async () => {
    let calls = 0;
    const provider = new BingSearchProvider(async () => {
      calls += 1;
      if (calls === 1) return new Promise<Response>(() => undefined);
      return new Response('<ol><li class="b_algo"><h2><a href="https://example.com/notes">Release notes</a></h2><p>Latest changes</p></li></ol>');
    }, ['cn.bing.com', 'www.bing.com'], 20);
    await expect(provider.search('release notes')).resolves.toEqual([{ title: 'Release notes', url: 'https://example.com/notes', snippet: 'Latest changes' }]);
    expect(calls).toBe(2);
  });

  it('ends a web request while hostname resolution is still pending', async () => {
    await expect(fetchWebPage('https://example.com/notes', {
      timeoutMs: 20, resolveHost: async () => new Promise<string[]>(() => undefined),
    })).rejects.toThrow();
  });

  it('ends a web request while a response body is still pending', async () => {
    const body = new ReadableStream<Uint8Array>({ start() { /* Leave an ordinary response open. */ } });
    try {
      await expect(fetchWebPage('https://example.com/notes', {
        timeoutMs: 20, resolveHost: async () => ['93.184.216.34'], fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/plain' } }),
      })).rejects.toThrow();
    } finally { void body.cancel().catch(() => undefined); }
  });
});

describe('memory tool scope', () => {
  it('requires a selected project when a caller explicitly requests project scope', async () => {
    const store = new MemoryStore(':memory:');
    const remember = createMemoryTools(store, {}).find((tool) => tool.name === 'remember')!;
    try {
      await expect(remember.execute('remember', { content: 'Use pnpm', scope: 'project' }, undefined, undefined, {} as never)).rejects.toThrow('未选择项目');
      expect(store.list()).toEqual([]);
    } finally { store.close(); }
  });
});
