import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, FileText, X } from 'lucide-react';
import { errorMessage } from '../format';

interface FilePreviewProps { path: string; onClose: () => void; }

export function FilePreview({ path, onClose }: FilePreviewProps) {
  const [content, setContent] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [size, setSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(undefined); setContent(''); setTruncated(false); setSize(0); setCopyState('idle');
    if (copyTimer.current) clearTimeout(copyTimer.current);
    if (!window.amd?.project?.file) { setLoading(false); setError('文件预览接口尚未连接'); return; }
    void window.amd.project.file(path).then((file) => {
      if (!active) return;
      setContent(file.content); setTruncated(file.truncated); setSize(file.size);
    }).catch((cause) => { if (active) setError(errorMessage(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); if (copyTimer.current) clearTimeout(copyTimer.current); };
  }, []);
  const copy = async () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable');
      await navigator.clipboard.writeText(content);
      setCopyState('copied');
    } catch { setCopyState('failed'); }
    copyTimer.current = setTimeout(() => setCopyState('idle'), 1500);
  };
  const lines = content ? content.split('\n').length : 0;
  return <div className="modal-overlay file-preview-overlay" role="presentation">
    <section className="modal-window file-preview-window" role="dialog" aria-modal="true" aria-label="文件预览">
      <header className="file-preview-header"><div><div className="eyebrow">FILE PREVIEW</div><h2><FileText size={16} />{path.split('/').pop()}</h2><p className="mono">{path}</p></div><div className="file-preview-actions">{!loading && !error && <button className="button outline small" onClick={() => void copy()}>{copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}</button>}<button className="close-button" onClick={onClose} aria-label="关闭文件预览">×</button></div></header>
      <div className="file-preview-meta"><span>{loading ? '读取中…' : error ? '读取失败' : lines + ' 行'}</span>{!loading && !error && <span>{Math.max(1, Math.round(size / 1024))} KB{truncated ? ' · 已截断' : ''}</span>}</div>
      {error ? <div className="memory-error" role="alert">{error}</div> : <pre className="file-preview-code" aria-busy={loading}>{loading ? 'Loading…' : content || '（空文件）'}</pre>}
    </section>
  </div>;
}
