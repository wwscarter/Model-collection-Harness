import { afterEach, describe, expect, it } from 'vitest';
import { SymbolExtractor } from '../../src/core/codebase/SymbolExtractor';

const extractors: SymbolExtractor[] = [];
function extractor(): SymbolExtractor { const value = new SymbolExtractor(); extractors.push(value); return value; }
afterEach(() => { for (const value of extractors.splice(0)) value.dispose(); });

describe('tree-sitter symbol extraction', () => {
  it.each([
    { file: 'example.ts', source: 'export interface Greeter { greet(): string }\nexport class Greeting { greet() { return "hello"; } }\nexport function sayHello(name: string): string { return name; }', expected: [['Greeter', 'interface'], ['Greeting', 'class'], ['sayHello', 'function'], ['greet', 'method']] },
    { file: 'example.js', source: 'export class Greeting {}\nexport function sayHello() {}\nexport const arrowHello = () => "hello";\nconst local = 1;\nexport { local as publicValue };', expected: [['Greeting', 'class'], ['sayHello', 'function'], ['arrowHello', 'function'], ['publicValue', 'export']] },
    { file: 'example.py', source: 'class Greeting:\n    def greet(self):\n        return "hello"\n\ndef say_hello(name):\n    return name\n', expected: [['Greeting', 'class'], ['greet', 'method'], ['say_hello', 'function']] },
    { file: 'example.go', source: 'package example\ntype Greeting struct {}\ntype Greeter interface { Greet() string }\nfunc SayHello() string { return "hello" }\nfunc (g Greeting) Greet() string { return "hello" }\n', expected: [['Greeting', 'class'], ['Greeter', 'interface'], ['SayHello', 'function'], ['Greet', 'method']] },
    { file: 'example.rs', source: 'pub struct Greeting {}\npub trait Greeter { fn greet(&self); }\npub fn say_hello() {}\nimpl Greeting { pub fn greet(&self) {} }\n', expected: [['Greeting', 'class'], ['Greeter', 'interface'], ['say_hello', 'function'], ['greet', 'method']] },
    { file: 'Example.java', source: 'public class Greeting {\n  public String greet() { return "hello"; }\n}\ninterface Greeter { String greet(); }\n', expected: [['Greeting', 'class'], ['greet', 'method'], ['Greeter', 'interface']] },
  ])('extracts declarations from $file', async ({ file, source, expected }) => {
    const result = await extractor().extract(file, source);
    expect(result.hasErrors).toBe(false);
    expect(result.truncated).toBe(false);
    for (const [name, kind] of expected) expect(result.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name, kind, path: file })]));
    expect(result.symbols.every((symbol) => symbol.line >= 1 && symbol.endLine >= symbol.line && symbol.signature.length <= 240)).toBe(true);
  });

  it('keeps exact lines and declaration signatures while omitting function bodies', async () => {
    const result = await extractor().extract('src/example.ts', '// header\n\nexport async function fetchName(\n  id: string,\n): Promise<string> {\n  return "body marker";\n}\n');
    expect(result.symbols).toMatchObject([{ name: 'fetchName', kind: 'function', path: 'src/example.ts', line: 3, endLine: 7, signature: 'async function fetchName( id: string, ): Promise<string>', exported: true, language: 'typescript' }]);
    expect(result.symbols[0].signature).not.toContain('body marker');
  });

  it('loads TSX on demand and returns no declarations for unsupported file types', async () => {
    const value = extractor();
    const result = await value.extract('Greeting.tsx', 'export const Greeting = () => <div>Hello</div>;');
    expect(result.symbols).toMatchObject([{ name: 'Greeting', kind: 'function', language: 'tsx', exported: true }]);
    expect(await value.extract('notes.md', '# heading')).toEqual({ symbols: [], truncated: false, hasErrors: false });
  });

  it('preserves recoverable declarations from a file with an ordinary syntax error', async () => {
    const result = await extractor().extract('broken.ts', 'export function valid() {}\nconst incomplete = ;');
    expect(result.hasErrors).toBe(true);
    expect(result.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'valid' })]));
  });

  it('indexes anonymous default exports and class expression methods', async () => {
    const value = extractor();
    expect((await value.extract('default.ts', 'export default function(value: string) { return value; }')).symbols).toMatchObject([{ name: 'default', kind: 'function', exported: true, signature: 'export default function(value: string)' }]);
    const result = await value.extract('handler.ts', 'export const Handler = class { handle = () => "ok"; };');
    expect(result.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Handler', kind: 'class', exported: true }), expect.objectContaining({ name: 'handle', kind: 'method' })]));
  });
});
