import type { MainContext } from '../MainContext';
import { readMcpLog, testConfiguredMcp } from '../mcpRuntime';
import { handle } from './register';

function serverName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw new Error('MCP 服务名称无效');
  return value;
}
export function register(ctx: MainContext): void {
  handle('agent:mcp:list', () => ctx.mcpConfig.list());
  handle('agent:mcp:save', (_event, name: unknown, draft: unknown) => {
    const id = serverName(name);
    const result = ctx.mcpConfig.save(id, draft);
    ctx.mcpTools.delete(id);
    return result;
  });
  handle('agent:mcp:remove', (_event, name: unknown) => {
    const id = serverName(name); const removed = ctx.mcpConfig.remove(id); ctx.mcpTools.delete(id);
    return { success: removed };
  });
  handle('agent:mcp:test', (_event, name: unknown) => testConfiguredMcp(ctx, serverName(name)));
  handle('agent:mcp:log', () => readMcpLog(ctx));
}
