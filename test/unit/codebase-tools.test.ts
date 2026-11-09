import { describe, expect, it, vi } from 'vitest';
import { createCodebaseTools } from '@core/tools/codebaseTools';
import type { CodebaseIndex } from '@core/codebase/CodebaseIndex';
import type { SemanticSearch } from '@core/codebase/SemanticSearch';

describe('host-owned codebase tools', () => {
  const fixture = () => {
    const symbols = [{ name: 'sum', path: 'src/sum.ts', line: 2, endLine: 4, kind: 'function', signature: 'function sum(a, b)', exported: true, language: 'typescript' }];
    const index = { refresh: vi.fn(async () => ({ files: 1, symbols: 1 })), symbols: vi.fn(async () => symbols) };
    const semantic = { search: vi.fn(async () => ({ status: 'ready', hits: [{ path: 'src/sum.ts', line: 2, endLine: 4, text: 'return a + b' }] })) };
    const tools = (enabled: boolean) => createCodebaseTools('/project', index as unknown as CodebaseIndex, semantic as unknown as SemanticSearch, enabled);
    return { index, semantic, tools, symbols };
  };
  it('refreshes the selected project before symbol lookup', async () => {
    const { index, tools } = fixture();
    const signal = new AbortController().signal;
    const result = await tools(false)[0].execute('fixture', { query: 'sum' }, signal, undefined, {} as never);
    expect(index.refresh).toHaveBeenCalledWith('/project', undefined, signal);
    expect(index.symbols).toHaveBeenCalledWith('/project', 'sum', undefined, 20);
    expect(result.content).toMatchObject([{ type: 'text', text: expect.stringContaining('src/sum.ts:2') }]);
    expect(tools(false).map((tool) => tool.name)).toEqual(['code_symbols']);
  });
  it('only exposes semantic search after explicit enablement and supplies symbol boundaries', async () => {
    const { index, semantic, tools, symbols } = fixture();
    const result = await tools(true)[1].execute('fixture', { query: 'add numbers', limit: 3 }, undefined, undefined, {} as never);
    expect(index.symbols).toHaveBeenCalledWith('/project', '', undefined, 100000);
    expect(semantic.search).toHaveBeenCalledWith('/project', 'add numbers', { signal: undefined, limit: 3, symbols });
    expect(result.content).toMatchObject([{ text: expect.stringContaining('return a + b') }]);
  });
  it('reports unavailable local search without caching failure and tolerates a missing parser', async () => {
    const { index } = fixture();
    index.refresh.mockRejectedValueOnce(new Error('parser unavailable'));
    const semantic = { search: vi.fn(async () => ({ status: 'unavailable' as const, reason: 'local model offline', hits: [], indexedFiles: 0, indexedChunks: 0, truncated: false })) };
    const tool = createCodebaseTools('/project', index as unknown as CodebaseIndex, semantic as unknown as SemanticSearch, true)[1];
    const result = await tool.execute('fixture', { query: 'add numbers' }, undefined, undefined, {} as never);
    expect(semantic.search).toHaveBeenCalledWith('/project', 'add numbers', { signal: undefined, limit: undefined, symbols: [] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject([{ text: expect.stringContaining('local model offline') }]);
  });
});
