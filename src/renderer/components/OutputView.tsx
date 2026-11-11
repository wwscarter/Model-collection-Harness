import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, ExternalLink, FileCode2 } from 'lucide-react';
import { highlightCode, type CodeToken } from '../highlightCode';
import { splitOutputBlocks } from '../outputBlocks';
import { mediaAssetUrl, type MediaArtifact, type MediaJobSummary } from '../mediaTypes';
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

function MediaCard({ artifact }: { artifact: MediaArtifact }) {
  const [missing, setMissing] = useState(false);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (action: 'open' | 'export') => {
    setActionError(''); setBusy(true);
    try {
      if (!window.amd?.media) throw new Error('媒体文件操作需要桌面应用');
      await window.amd.media[action](artifact.id);
    } catch { setActionError(action === 'open' ? '无法打开文件，请检查文件是否仍然存在。' : '保存文件失败，请重试。'); }
    finally { setBusy(false); }
  };
  return <figure className="media-result" aria-label={artifact.kind === 'image' ? '生成的图片' : '生成的视频'}>
    {missing ? <div className="media-missing" role="status">文件暂时无法预览，可能已被移动或删除。</div> : artifact.kind === 'image'
      ? <img className="media-preview" src={mediaAssetUrl(artifact.id)} alt="生成的图片" loading="lazy" onError={() => setMissing(true)} />
      : <video className="media-preview" src={mediaAssetUrl(artifact.id)} controls preload="metadata" onError={() => setMissing(true)} />}
    <figcaption><div><strong>{artifact.kind === 'image' ? '图片' : '视频'}</strong><span>{artifact.width && artifact.height ? artifact.width + ' × ' + artifact.height + ' · ' : ''}{artifact.modelId}</span></div><div className="media-actions"><button type="button" disabled={busy} onClick={() => void act('open')}><ExternalLink size={13} />打开</button><button type="button" disabled={busy} onClick={() => void act('export')}><Download size={13} />另存为</button></div></figcaption>
    {actionError && <div className="media-action-error" role="alert">{actionError}</div>}
  </figure>;
}

const mediaStatusLabels: Record<MediaJobSummary['status'], string> = { queued: '等待生成', submitting: '正在提交', running: '正在生成', downloading: '正在保存', succeeded: '生成完成', failed: '生成失败', unknown: '结果待确认', cancelled: '已停止' };

export const OutputView = React.memo(function OutputView({ content, loading, emptyState, artifacts = [], mediaJobs = [] }: { content: string; loading: boolean; emptyState: boolean; artifacts?: MediaArtifact[]; mediaJobs?: MediaJobSummary[] }) {
  const blocks = useMemo(() => splitOutputBlocks(content), [content]);
  const visibleJobs = mediaJobs.filter((job) => !artifacts.some((artifact) => artifact.jobId === job.id));
  const hasMedia = artifacts.length > 0 || visibleJobs.length > 0;
  if (loading && !content && !hasMedia) return <div className="output-pending"><i className="live-dot pulse" />正在规划并执行任务…</div>;
  if (!content && !emptyState && !hasMedia) return null;
  if (!content && !hasMedia) return <div className="output-empty"><strong>输出会显示在这里</strong><span>描述你的任务，newAi 会自动选择模型并执行。</span></div>;
  return <div className="output-content rich-output" aria-busy={loading}>{blocks.map((block) => block.type === 'code'
    ? <CodeBlock key={block.id} language={block.language} code={block.content} generating={loading && !block.complete} />
    : <ResponseText key={block.id} content={block.content} />)}{visibleJobs.map((job) => <div key={job.id} className="media-job-status" role="status"><strong>{job.operation === 'image.generate' ? '图片' : '视频'} · {mediaStatusLabels[job.status]}</strong>{job.modelId && <span>{job.modelId}</span>}{job.error && <span>{job.error}</span>}</div>)}{artifacts.map((artifact) => <MediaCard key={artifact.id} artifact={artifact} />)}{loading && content && <span className="streaming-cursor" aria-label="正在生成">▍</span>}</div>;
});
