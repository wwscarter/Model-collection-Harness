import { refractor } from 'refractor/core';
import bash from 'refractor/bash';
import css from 'refractor/css';
import javascript from 'refractor/javascript';
import json from 'refractor/json';
import jsx from 'refractor/jsx';
import markdown from 'refractor/markdown';
import markup from 'refractor/markup';
import python from 'refractor/python';
import tsx from 'refractor/tsx';
import typescript from 'refractor/typescript';
import yaml from 'refractor/yaml';
import type { RootContent } from 'hast';

for (const syntax of [markup, css, javascript, jsx, typescript, tsx, json, bash, python, markdown, yaml]) refractor.register(syntax);

export type CodeToken = { type: 'text'; value: string } | { type: 'token'; className: string; children: CodeToken[] };
export interface HighlightedCode { language: string; label: string; highlighted: boolean; tokens: CodeToken[]; }

const aliases: Record<string, string> = {
  ts: 'typescript', js: 'javascript', sh: 'bash', shell: 'bash', shellscript: 'bash', zsh: 'bash',
  py: 'python', html: 'markup', xml: 'markup', md: 'markdown', yml: 'yaml', txt: 'text', plaintext: 'text',
};
const labels: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', jsx: 'JSX', tsx: 'TSX', json: 'JSON', markup: 'HTML',
  css: 'CSS', bash: 'Shell', python: 'Python', markdown: 'Markdown', yaml: 'YAML', text: '纯文本',
};

function tokensFromAst(nodes: RootContent[]): CodeToken[] {
  return nodes.flatMap((node): CodeToken[] => {
    if (node.type === 'text') return [{ type: 'text', value: node.value }];
    if (node.type !== 'element') return [];
    const classes = node.properties.className;
    const className = (Array.isArray(classes) ? classes : []).filter((name): name is string => typeof name === 'string' && /^[\w-]+$/.test(name)).join(' ');
    return [{ type: 'token', className, children: tokensFromAst(node.children) }];
  });
}

/** Only text and token classes cross into the React renderer; AST attributes do not. */
export function highlightCode(code: string, suppliedLanguage: string): HighlightedCode {
  const sourceLanguage = suppliedLanguage.trim().toLowerCase().replace(/^language-/, '');
  const language = aliases[sourceLanguage] || sourceLanguage || 'text';
  const label = labels[language] || suppliedLanguage.slice(0, 40) || labels.text;
  const plain: HighlightedCode = { language, label, highlighted: false, tokens: [{ type: 'text', value: code }] };
  // Large responses stay readable without repeatedly tokenizing the whole stream.
  if (code.length > 80_000 || !refractor.registered(language)) return plain;
  try {
    return { language, label, highlighted: true, tokens: tokensFromAst(refractor.highlight(code, language).children) };
  } catch {
    return plain;
  }
}
