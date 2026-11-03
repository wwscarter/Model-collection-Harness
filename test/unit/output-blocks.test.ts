import { describe, expect, it } from 'vitest';
import { splitOutputBlocks } from '../../src/renderer/outputBlocks';
import { highlightCode, type CodeToken } from '../../src/renderer/highlightCode';

const textOf = (tokens: CodeToken[]): string => tokens.map((token) => token.type === 'text' ? token.value : textOf(token.children)).join('');

describe('streamed response blocks', () => {
  it('preserves prose and multiple fenced blocks in their original order', () => {
    const blocks = splitOutputBlocks('先读取配置。\n\n```json\n{"ready": true}\n```\n\n再启动应用。\n```sh\nnpm run dev\n```');
    expect(blocks.map((block) => block.type)).toEqual(['text', 'code', 'text', 'code']);
    expect(blocks[1]).toMatchObject({ language: 'json', content: '{"ready": true}\n', complete: true });
    expect(blocks[3]).toMatchObject({ language: 'sh', content: 'npm run dev\n', complete: true });
  });

  it('renders an unfinished streaming fence immediately without losing its contents', () => {
    const partial = '```tsx\nconst App = () => <main>你好</main>;';
    expect(splitOutputBlocks(partial)).toEqual([{ type: 'code', id: 'code-0', language: 'tsx', content: 'const App = () => <main>你好</main>;', complete: false }]);
    const completed = splitOutputBlocks(partial + '\n```\n后续说明');
    expect(completed[0]).toMatchObject({ complete: true });
    expect(completed[1]).toMatchObject({ type: 'text', content: '后续说明' });
  });

  it('keeps shorter fences inside a longer fenced block and supports CRLF', () => {
    const blocks = splitOutputBlocks('````md\r\n```ts\r\nconst x = 1;\r\n```\r\n````');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ language: 'md', content: '```ts\r\nconst x = 1;\r\n```\r\n', complete: true });
  });

  it('leaves inline code fences in prose and accepts tilde code fences', () => {
    expect(splitOutputBlocks('说明中的 ``` 不是代码块。')).toEqual([{ type: 'text', id: 'text-0', content: '说明中的 ``` 不是代码块。' }]);
    expect(splitOutputBlocks('~~~python\nprint(1)\n~~~')[0]).toMatchObject({ type: 'code', language: 'python', content: 'print(1)\n', complete: true });
  });
});

describe('syntax token AST', () => {
  it('highlights TSX while retaining all source text for the renderer', () => {
    const source = 'const App = () => <main title="你好">{42}</main>;';
    const result = highlightCode(source, 'tsx');
    expect(result.highlighted).toBe(true);
    expect(result.label).toBe('TSX');
    expect(result.tokens.some((token) => token.type === 'token')).toBe(true);
    expect(textOf(result.tokens)).toBe(source);
  });

  it('uses readable plain text for an unsupported language', () => {
    const source = 'custom { value: 1 }';
    expect(highlightCode(source, 'my-format')).toEqual({ language: 'my-format', label: 'my-format', highlighted: false, tokens: [{ type: 'text', value: source }] });
  });

  it.each([['ts', 'const ready: boolean = true;'], ['js', 'export default 1;'], ['json', '{"value": 1}'], ['html', '<main>ready</main>'], ['css', 'main { color: green; }'], ['sh', 'echo ready'], ['py', 'print(1)'], ['md', '# Heading'], ['yml', 'ready: true']])('supports the %s fence alias', (language, source) => {
    const result = highlightCode(source, language);
    expect(result.highlighted).toBe(true);
    expect(textOf(result.tokens)).toBe(source);
  });
});
