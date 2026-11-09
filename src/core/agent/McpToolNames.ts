import { createHash } from 'node:crypto';

const MAX_TOOL_NAME_LENGTH = 64;
const plainName = (server: string, tool: string) => ('mcp__' + server + '__' + tool).replace(/[^A-Za-z0-9_]/g, '_');

/**
 * Pi 1.5.0 does not publicly export its MCP name mapper. Keep this adapter in
 * contract with extensions/mcp/tools.js and its registration collision rules.
 */
function mappedName(server: string, tool: string, taken: (name: string) => boolean = () => false): string {
  const name = plainName(server, tool);
  if (name.length <= MAX_TOOL_NAME_LENGTH && !taken(name)) return name;
  const hash = createHash('sha256').update(server + '\0' + tool).digest('hex').slice(0, 8);
  return name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1) + '_' + hash;
}

/** Names shown in settings must be the same identifiers Pi sends to the tool gate. */
export function mcpToolNames(server: string, tools: string[], configuredServers: string[] = [server]): string[] {
  if (new Set(tools).size !== tools.length) throw new Error('MCP 服务返回了重复工具名称，请修正服务器的工具清单。');
  const plain = tools.map((tool) => mappedName(server, tool));
  const current = new Set<string>();
  const names = tools.map((tool) => {
    const name = mappedName(server, tool, (candidate) => current.has(candidate) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate));
    if (current.has(name)) throw new Error('MCP 工具名称无法唯一确定，请调整服务器的工具名称。');
    current.add(name);
    return name;
  });
  // Pi resolves cross-server collisions in actual connection order. A connection
  // test has only one server's tool list, so do not guess an id for overlapping
  // namespaces: report the configuration issue before storing a trust choice.
  for (const other of configuredServers) {
    if (other === server) continue;
    const prefix = ('mcp__' + other + '__').replace(/[^A-Za-z0-9_]/g, '_');
    if (names.some((name) => name.startsWith(prefix))) throw new Error('MCP 服务已连接，但工具命名空间与「' + other + '」重叠，无法确定实际工具标识；请调整服务器名称后重新测试。');
  }
  return names;
}
