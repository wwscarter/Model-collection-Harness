import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CodebaseIndex } from '@core/codebase/CodebaseIndex';
import type { SemanticSearch } from '@core/codebase/SemanticSearch';
import type { CodeSearchConfig } from '@core/codebase/CodeSearchConfig';

interface CodeSearchSnapshot { config: CodeSearchConfig; baseURL: string; }

/** The host owns the local stores; tools only operate on the selected project. */
export function createCodebaseTools(root: string, index: CodebaseIndex, semantic: SemanticSearch, enableSemantic: boolean, snapshot?: CodeSearchSnapshot): ToolDefinition[] {
  const tools: ToolDefinition[] = [defineTool({
    name: 'code_symbols', label: '检索代码符号',
    description: 'Find locally indexed functions, classes, interfaces and exports. Returns project path, line and signature; use read to inspect the implementation.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200 }),
      kind: Type.Optional(Type.String({ maxLength: 40 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_id, params, signal) {
      const stats = await index.refresh(root, undefined, signal);
      const symbols = await index.symbols(root, params.query, params.kind, params.limit ?? 20);
      const errors = stats.errors ?? [];
      const lines = symbols.map((symbol) => symbol.path + ':' + symbol.line + ' [' + symbol.kind + '] ' + symbol.signature);
      if (stats.truncated) lines.push('[索引不完整：已达到扫描或提取限额；请使用 grep 缩小目录检索。]');
      if (errors.length) lines.push('[部分文件未能建立索引]\n' + errors.slice(0, 5).join('\n'));
      return { content: [{ type: 'text', text: lines.join('\n') || '没有找到匹配的代码符号。' }], details: { symbols, stats }, isError: errors.length > 0 && !symbols.length };
    },
  }) as unknown as ToolDefinition];
  if (enableSemantic) tools.push(defineTool({
    name: 'code_search', label: '本机语义检索',
    description: 'Search project code using an explicitly configured local Ollama embedding model and local full-text search. Returns relevant excerpts with paths and lines.',
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 4000 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
    async execute(_id, params, signal) {
      let symbols: Awaited<ReturnType<CodebaseIndex['symbols']>> = [];
      let indexNotice = '';
      try {
        const stats = await index.refresh(root, undefined, signal);
        symbols = await index.symbols(root, '', undefined, 100_000);
        if (stats.truncated || stats.errors?.length) indexNotice = '\n[符号边界索引不完整，已同时使用普通文件分块。]';
      } catch (cause) {
        signal?.throwIfAborted();
        indexNotice = '\n[符号索引不可用，已使用普通文件分块：' + (cause instanceof Error ? cause.message : String(cause)).slice(0, 300) + ']';
      }
      const result = await semantic.search(root, params.query, { signal, limit: params.limit, symbols, ...snapshot });
      let text = result.status === 'ready'
        ? result.hits.map((hit) => hit.path + ':' + hit.line + '-' + hit.endLine + '\n' + hit.text).join('\n\n') || '没有找到相关代码。'
        : result.reason ?? '本机语义检索不可用，请使用 grep、find 或 code_symbols。';
      if (result.truncated) text += '\n[索引不完整：文件或代码块已达到限额，部分代码未参与检索。]';
      return { content: [{ type: 'text', text: text + indexNotice }], details: result, isError: result.status !== 'ready' };
    },
  }) as unknown as ToolDefinition);
  return tools;
}
