import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import Parser from 'web-tree-sitter';
import type { CodeLanguage, CodeSymbol, CodeSymbolKind } from './CodebaseTypes';

export type { CodeLanguage, CodeSymbol, CodeSymbolKind } from './CodebaseTypes';
export interface SymbolExtraction { symbols: CodeSymbol[]; truncated: boolean; hasErrors: boolean; }

const require = createRequire(import.meta.url);
const EXTENSIONS: Record<string, CodeLanguage> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
};
const DECLARATIONS: Record<string, CodeSymbolKind> = {
  function_declaration: 'function', generator_function_declaration: 'function', function_signature: 'function',
  function_definition: 'function', function_item: 'function', function_signature_item: 'function',
  class_declaration: 'class', abstract_class_declaration: 'class', class_definition: 'class',
  struct_item: 'class', enum_item: 'class', enum_declaration: 'class', record_declaration: 'class',
  interface_declaration: 'interface', trait_item: 'interface', annotation_type_declaration: 'interface',
  method_declaration: 'method', method_definition: 'method', method_signature: 'method', abstract_method_signature: 'method', constructor_declaration: 'method',
  type_alias_declaration: 'type', type_item: 'type', type_alias: 'type',
};

function ancestor(node: Parser.SyntaxNode, predicate: (parent: Parser.SyntaxNode) => boolean): boolean {
  let parent = node.parent;
  while (parent) {
    if (predicate(parent)) return true;
    if (/function|method|class|interface|struct|trait/.test(parent.type)) return false;
    parent = parent.parent;
  }
  return false;
}

function isExported(node: Parser.SyntaxNode, language: CodeLanguage, name: string): boolean {
  if (language === 'go') return /^[A-Z]/.test(name);
  if (language === 'java') return node.namedChildren.some((child) => child.type === 'modifiers' && /\bpublic\b/.test(child.text));
  if (language === 'rust') return node.namedChildren.some((child) => child.type === 'visibility_modifier' && child.text.startsWith('pub'));
  return ancestor(node, (parent) => parent.type === 'export_statement');
}

function signature(node: Parser.SyntaxNode): string {
  const value = ['variable_declarator', 'export_statement', 'public_field_definition', 'field_definition'].includes(node.type) ? node.childForFieldName('value') : undefined;
  const body = node.childForFieldName('body') ?? value?.childForFieldName('body');
  const text = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function declaration(node: Parser.SyntaxNode, language: CodeLanguage): { name: string; kind: CodeSymbolKind } | undefined {
  let kind = DECLARATIONS[node.type];
  let name = node.childForFieldName('name')?.text;
  if (node.type === 'type_spec' && language === 'go') {
    const type = node.childForFieldName('type')?.type;
    kind = type === 'interface_type' ? 'interface' : type === 'struct_type' ? 'class' : 'type';
  }
  if (node.type === 'function_definition' && ancestor(node, (parent) => parent.type === 'class_definition')) kind = 'method';
  if (['function_item', 'function_signature_item'].includes(node.type) && ancestor(node, (parent) => parent.type === 'impl_item' || parent.type === 'trait_item')) kind = 'method';
  if (node.type === 'variable_declarator') {
    const value = node.childForFieldName('value');
    if (value && ['arrow_function', 'function_expression', 'generator_function'].includes(value.type)) kind = 'function';
    else if (value && ['class', 'class_expression'].includes(value.type)) kind = 'class';
    else if (ancestor(node, (parent) => parent.type === 'export_statement')) kind = 'export';
  }
  if (['public_field_definition', 'field_definition'].includes(node.type)) {
    const value = node.childForFieldName('value');
    if (value && ['arrow_function', 'function_expression'].includes(value.type)) kind = 'method';
  }
  if (node.type === 'export_statement' && /\bdefault\b/.test(node.text.slice(0, 30))) {
    const value = node.childForFieldName('value');
    if (value && !value.childForFieldName('name')) {
      name = 'default';
      kind = ['function_expression', 'arrow_function'].includes(value.type) ? 'function' : value.type === 'class' ? 'class' : 'export';
    }
  }
  if (node.type === 'export_specifier') {
    kind = 'export';
    name = node.childForFieldName('alias')?.text ?? node.childForFieldName('name')?.text;
  }
  if (!kind || !name || name.length > 300 || /[\n\r]/.test(name)) return undefined;
  return { name, kind };
}

/** Lazily load only the grammar needed by a file; normal indexing runs this in a worker. */
export class SymbolExtractor {
  private static initialization?: Promise<void>;
  private parsers = new Map<CodeLanguage, Promise<Parser>>();
  private disposed = false;
  private grammarRoot?: string;

  constructor(grammarRoot?: string) { this.grammarRoot = grammarRoot; }

  static language(filePath: string): CodeLanguage | undefined { return EXTENSIONS[path.extname(filePath).toLowerCase()]; }

  private parser(language: CodeLanguage): Promise<Parser> {
    if (this.disposed) throw new Error('Symbol extractor is disposed');
    let result = this.parsers.get(language);
    if (!result) {
      result = (async () => {
        if (!SymbolExtractor.initialization) {
          const initialization = Parser.init({ locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm') });
          SymbolExtractor.initialization = initialization;
          void initialization.catch(() => { if (SymbolExtractor.initialization === initialization) SymbolExtractor.initialization = undefined; });
        }
        await SymbolExtractor.initialization;
        const name = 'tree-sitter-' + language + '.wasm';
        const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
        const directory = this.grammarRoot ?? (resourcesPath ? path.join(resourcesPath, 'codebase-grammars') : undefined);
        const bundled = directory ? path.join(directory, name) : undefined;
        const grammar = await Parser.Language.load(bundled && fs.existsSync(bundled) ? bundled : require.resolve('tree-sitter-wasms/out/' + name));
        const parser = new Parser();
        parser.setLanguage(grammar);
        parser.setTimeoutMicros(250_000);
        if (this.disposed) { parser.delete(); throw new Error('Symbol extractor is disposed'); }
        return parser;
      })();
      this.parsers.set(language, result);
      result.catch(() => this.parsers.delete(language));
    }
    return result;
  }

  async extract(filePath: string, source: string): Promise<SymbolExtraction> {
    const language = SymbolExtractor.language(filePath);
    if (!language) return { symbols: [], truncated: false, hasErrors: false };
    const parser = await this.parser(language);
    let tree: Parser.Tree | undefined;
    try {
      tree = parser.parse(source);
      if (!tree) throw new Error('Parsing exceeded the per-file time limit');
      const symbols: CodeSymbol[] = [];
      const stack = [tree.rootNode];
      let visited = 0;
      while (stack.length && symbols.length < 5_000 && visited < 250_000) {
        const node = stack.pop()!;
        visited += 1;
        const entry = declaration(node, language);
        if (entry) symbols.push({ ...entry, path: filePath, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1, signature: signature(node), exported: ['export_specifier', 'export_statement'].includes(node.type) || isExported(node, language, entry.name), language });
        const children = node.namedChildren;
        for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
      }
      return { symbols, truncated: stack.length > 0, hasErrors: tree.rootNode.hasError() };
    } finally {
      tree?.delete();
      parser.reset();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const parser of this.parsers.values()) void parser.then((value) => value.delete(), () => undefined);
    this.parsers.clear();
  }
}
