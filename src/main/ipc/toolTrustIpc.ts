import type { ToolTrustStore } from '@core/security/ToolTrustStore';
import type { MainContext } from '../MainContext';
import { handle } from './register';

type ToolContext = MainContext & { toolTrust: ToolTrustStore; mcpTools: Map<string, string[]> };
export function register(ctx: ToolContext): void {
  handle('agent:tool-trust:get', async () => {
    const description = await ctx.agentRuntime.describe();
    const choices = ctx.toolTrust.list();
    const builtins = [...new Set([...description.tools, 'ls', 'grep', 'find', 'write', 'edit', 'run_command', 'process_status', 'process_list', 'stop_process', 'code_symbols', 'code_search', 'update_plan'])];
    const mcpNames = new Set([...ctx.mcpTools.values()].flat());
    const names = new Set([...builtins, ...Object.keys(choices), ...mcpNames]);
    return {
      tools: [...names].sort().map((name) => ({ name, trust: choices[name], source: mcpNames.has(name) || name.startsWith('mcp__') ? 'mcp' : 'builtin' })),
      diagnostics: [...ctx.toolTrust.diagnostics],
    };
  });
  handle('agent:tool-trust:set', (_event, name: unknown, trust: unknown) => ctx.toolTrust.set(name, trust));
}
