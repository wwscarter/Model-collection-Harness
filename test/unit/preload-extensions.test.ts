import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SkillsApi } from '../../src/renderer/skillsTypes';
import type { McpApi } from '../../src/renderer/mcpTypes';
import type { ToolTrustApi } from '../../src/renderer/toolTrustTypes';

const state = vi.hoisted(() => ({ api: undefined as unknown as { agent: { skills: SkillsApi; mcp: McpApi; toolTrust: ToolTrustApi } }, invoke: vi.fn(async () => undefined) }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: typeof state.api) => { state.api = api; } }, ipcRenderer: { invoke: state.invoke, on: vi.fn(), removeListener: vi.fn() } }));
beforeAll(async () => { await import('../../src/main/preload'); });

describe('extension management preload API', () => {
  it('forwards managed identities, import tokens and complete MCP drafts', async () => {
    const { skills, mcp, toolTrust } = state.api.agent;
    const draft = { type: 'stdio' as const, command: 'node', args: ['ordinary-server.mjs'] };
    await skills.list(); await skills.openDirectory(); await skills.previewImport(); await skills.confirmImport('opaque-import-token'); await skills.setEnabled('ordinary-directory', false);
    await mcp.list(); await mcp.save('documents', draft); await mcp.remove('documents'); await mcp.test('documents'); await mcp.log();
    await toolTrust.get(); await toolTrust.set('read', 'ask');
    expect(state.invoke.mock.calls).toEqual([
      ['agent:skills:list'], ['agent:skills:open-directory'], ['agent:skills:preview-import'], ['agent:skills:confirm-import', 'opaque-import-token'], ['agent:skills:set-enabled', 'ordinary-directory', false],
      ['agent:mcp:list'], ['agent:mcp:save', 'documents', draft], ['agent:mcp:remove', 'documents'], ['agent:mcp:test', 'documents'], ['agent:mcp:log'],
      ['agent:tool-trust:get'], ['agent:tool-trust:set', 'read', 'ask'],
    ]);
  });
});
