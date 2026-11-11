import { describe, expect, it } from 'vitest';
import { createMemoryTools } from '../../src/core/tools/memoryTools';
import { MemoryStore } from '../../src/core/memory/MemoryStore';

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
