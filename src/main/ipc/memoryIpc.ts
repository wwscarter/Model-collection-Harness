import type { MemoryKind } from '@core/memory/MemoryStore';
import type { MainContext } from '../MainContext';
import { handle } from './register';

export function register(ctx: MainContext): void {
  const { memoryStore, projects } = ctx;
  handle('memory:list', (_event, options?: { scope?: 'global' | 'project' | 'session' } | null) => {
    const projectRoot = projects.getRoot();
    const scope = options?.scope;
    const records = scope === 'global' ? memoryStore.list({ scopes: ['global'], status: 'all' })
      : scope === 'project' ? (projectRoot ? memoryStore.list({ scopes: ['project'], projectRoot, status: 'all' }) : [])
        : [
          ...memoryStore.list({ scopes: ['global'], status: 'all' }),
          ...(projectRoot ? memoryStore.list({ scopes: ['project'], projectRoot, status: 'all' }) : []),
        ];
    return records.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 200);
  });
  handle('memory:add', (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('记忆参数无效');
    const value = input as { content?: unknown; kind?: unknown; scope?: unknown; tags?: unknown };
    if (typeof value.content !== 'string') throw new Error('记忆内容无效');
    const projectRoot = projects.getRoot();
    const scope = value.scope === 'global' ? 'global' : projectRoot ? 'project' : 'global';
    const kinds: MemoryKind[] = ['preference', 'fact', 'decision', 'todo', 'artifact'];
    const kind = typeof value.kind === 'string' && kinds.includes(value.kind as MemoryKind) ? value.kind as MemoryKind : 'fact';
    return memoryStore.add({
      content: value.content,
      kind,
      scope,
      projectRoot: scope === 'project' ? projectRoot : undefined,
      source: 'user',
      tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    });
  });
  handle('memory:remove', (_event, id: unknown) => typeof id === 'string' ? { success: memoryStore.remove(id) } : { success: false });
  handle('memory:approve', (_event, id: unknown) => typeof id === 'string' ? { success: memoryStore.approve(id) } : { success: false });
  handle('memory:approve-many', (_event, ids: unknown) => ({ count: Array.isArray(ids) ? memoryStore.approveMany(ids) : 0 }));
  handle('memory:remove-many', (_event, ids: unknown) => ({ count: Array.isArray(ids) ? memoryStore.removeMany(ids) : 0 }));
  handle('memory:export', () => memoryStore.exportAll());
  handle('memory:clear', () => ({ removed: memoryStore.clear() }));
  handle('memory:settings', () => ({ autoExtract: memoryStore.getAutoExtract() }));
  handle('memory:set-auto-extract', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('自动提取设置无效');
    memoryStore.setAutoExtract(enabled);
    return { autoExtract: enabled };
  });
}
