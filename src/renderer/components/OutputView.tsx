import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, FileCode2 } from 'lucide-react';
import { highlightCode, type CodeToken } from '../highlightCode';
import { splitOutputBlocks } from '../outputBlocks';
import '../styles/output.css';

function renderTokens(tokens: CodeToken[], prefix = ''): React.ReactNode[] {
  return tokens.map((token, index) => token.type === 'text' ? token.value : <span key={prefix + index} className={token.className}>{renderTokens(token.children, prefix + index + '-')}</span>);
}

function InlineText({ text }: { text: string }) {
  return <>{text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) => part.startsWith('`') && part.endsWith('`')
    ? <code key={index}>{part.slice(1, -1)}</code>
    : part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part)}</>;
}

function ResponseText({ content }: { content: string }) {
  const paragraphs = content.replace(/^\n+|\n+$/g, '').split(/\n[ \t]*\n/);
  return <div className="response-prose">{paragraphs.filter(Boolean).map((paragraph, index) => {
    const lines = paragraph.split('\n');
    if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) return <ul key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}><InlineText text={line.replace(/^\s*[-*+]\s+/, '')} /></li>)}</ul>;
    if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) return <ol key={index} start={Number(/^\s*(\d+)/.exec(lines[0])?.[1]) || 1}>{lines.map((line, lineIndex) => <li key={lineIndex}><InlineText text={line.replace(/^\s*\d+[.)]\s+/, '')} /></li>)}</ol>;
    return <div className="response-paragraph" key={index}>{lines.map((line, lineIndex) => {
      const heading = /^#{1,6}\s+(.+)$/.exec(line);
      return heading ? <h3 key={lineIndex}><InlineText text={heading[1]} /></h3> : <React.Fragment key={lineIndex}><InlineText text={line} />{lineIndex < lines.length - 1 && <br />}</React.Fragment>;
    })}</div>;
  })}</div>;
}

function CodeBlock({ language, code, generating }: { language: string; code: string; generating: boolean }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const displayCode = code.replace(/\r?\n$/, '');
  const highlighted = useMemo(() => highlightCode(displayCode, language), [displayCode, language]);
  const lineCount = displayCode.split('\n').length;
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const copy = async () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable');
      await navigator.clipboard.writeText(code);
      setCopyState('copied');
    } catch { setCopyState('failed'); }
    copyTimer.current = setTimeout(() => setCopyState('idle'), 1800);
  };
  return <section className="code-block highlighted-code" aria-label={highlighted.label + ' 代码块'}>
    <header className="code-block-header">
      <div className="code-heading"><span className="code-file-icon"><FileCode2 size={14} /></span><strong>{highlighted.label}</strong><span className="code-line-count">{lineCount} 行</span></div>
      <div className="code-header-actions">{generating && <span className="code-stream-label"><i className="live-dot pulse" />生成中</span>}<button type="button" onClick={() => void copy()} aria-label="复制代码" aria-live="polite">{copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}</button></div>
    </header>
    <div className="code-viewport" tabIndex={0} role="region" aria-label={highlighted.label + ' 代码，可滚动'}>
      <div className="code-layout"><div className="code-line-numbers" aria-hidden="true">{Array.from({ length: lineCount }, (_, index) => <span key={index}>{index + 1}</span>)}</div><pre><code className={'language-' + highlighted.language}>{renderTokens(highlighted.tokens)}</code></pre></div>
    </div>
  </section>;
}

export function OutputView({ content, loading, emptyState }: { content: string; loading: boolean; emptyState: boolean }) {
  const blocks = useMemo(() => splitOutputBlocks(content), [content]);
  if (loading && !content) return <div className="output-pending"><i className="live-dot pulse" />正在规划并执行任务…</div>;
  if (!content && !emptyState) return null;
  if (!content) return <div className="output-empty"><strong>输出会显示在这里</strong><span>描述你的任务，newAi 会自动选择模型并执行。</span></div>;
  return <div className="output-content rich-output" aria-busy={loading}>{blocks.map((block) => block.type === 'code'
    ? <CodeBlock key={block.id} language={block.language} code={block.content} generating={loading && !block.complete} />
    : <ResponseText key={block.id} content={block.content} />)}{loading && <span className="streaming-cursor" aria-label="正在生成">▍</span>}</div>;
}
