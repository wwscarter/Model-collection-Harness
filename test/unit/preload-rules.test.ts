import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RulesApi } from '../../src/renderer/rulesTypes';

const state = vi.hoisted(() => ({ api: undefined as unknown as { agent: { rules: RulesApi } }, invoke: vi.fn(async () => undefined) }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: typeof state.api) => { state.api = api; } },
  ipcRenderer: { invoke: state.invoke, on: vi.fn(), removeListener: vi.fn() },
}));
beforeAll(async () => { await import('../../src/main/preload'); });

describe('rules preload methods', () => {
  it('forwards rule management through the agreed IPC channels and arguments', async () => {
    const rule = { name: 'working', content: '解释普通项目变更。', enabled: true };
    await state.api.agent.rules.list();
    await state.api.agent.rules.saveGlobal(rule);
    await state.api.agent.rules.setEnabled('working', false);
    await state.api.agent.rules.removeGlobal('working');
    await state.api.agent.rules.trustProject('/project/AGENTS.md', 'ordinary-content-hash');
    expect(state.invoke.mock.calls).toEqual([
      ['agent:rules:list'], ['agent:rules:save', rule], ['agent:rules:set-enabled', 'working', false],
      ['agent:rules:remove', 'working'], ['agent:rules:trust', '/project/AGENTS.md', 'ordinary-content-hash'],
    ]);
  });
});
