import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { HooksApi } from '../../src/renderer/hooksTypes';

const state = vi.hoisted(() => ({ api: undefined as unknown as { agent: { hooks: HooksApi } }, invoke: vi.fn(async () => undefined) }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: typeof state.api) => { state.api = api; } }, ipcRenderer: { invoke: state.invoke, on: vi.fn(), removeListener: vi.fn() } }));
beforeAll(async () => { await import('../../src/main/preload'); });

describe('Hooks preload methods', () => {
  it('uses the current-project list and trust channels without a renderer path', async () => {
    const config = { version: 1 as const, hooks: [] };
    await state.api.agent.hooks.list();
    await state.api.agent.hooks.saveGlobal(config);
    await state.api.agent.hooks.trustProject('ordinary-content-hash');
    expect(state.invoke.mock.calls).toEqual([['agent:hooks:list'], ['agent:hooks:save', config], ['agent:hooks:trust', 'ordinary-content-hash']]);
  });
});
