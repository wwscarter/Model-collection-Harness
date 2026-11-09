import { describe, expect, it } from 'vitest';
import { mcpToolNames } from '../../src/core/agent/McpToolNames';

// A read-only contract against the installed, pinned SDK implementation. The
// helper is not part of Pi's public package exports, so production does not
// import this path. These tests compare names only and never call an MCP tool.
const sdk = await import(new URL('./extensions/mcp/tools.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href) as {
  createMcpToolName(server: string, tool: string, taken?: (name: string) => boolean): string;
};
function registeredNames(server: string, tools: string[]) {
  const plain = [...new Set(tools)].map((tool) => sdk.createMcpToolName(server, tool));
  const current = new Set<string>();
  return tools.map((tool) => {
    const name = sdk.createMcpToolName(server, tool, (candidate) => current.has(candidate) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate));
    current.add(name);
    return name;
  });
}

describe('MCP tool naming contract', () => {
  it.each([
    { server: 'local-docs', tools: ['greet', 'read-file', 'sum.total', 'docs/list'] },
    { server: 'ordinary', tools: ['read-file', 'read_file', 'Résumé'] },
    { server: 'reference'.repeat(8), tools: ['read', 'list-tools', 'ordinary-'.repeat(12)] },
  ])('matches Pi registration for $server', ({ server, tools }) => {
    const names = mcpToolNames(server, tools);
    expect(names).toEqual(registeredNames(server, tools));
    expect(new Set(names).size).toBe(tools.length);
    expect(names.every((name) => name.length <= 64 && /^[A-Za-z0-9_]+$/.test(name))).toBe(true);
  });

  it('diagnoses overlapping server namespaces instead of inventing connection-order dependent names', () => {
    expect(() => mcpToolNames('alpha__beta', ['read'], ['alpha', 'alpha__beta'])).toThrow('命名空间');
    expect(() => mcpToolNames('alpha', ['beta__read'], ['alpha', 'alpha__beta'])).toThrow('命名空间');
    expect(mcpToolNames('alpha', ['ordinary'], ['alpha', 'alpha__beta'])).toEqual(['mcp__alpha__ordinary']);
  });
});
