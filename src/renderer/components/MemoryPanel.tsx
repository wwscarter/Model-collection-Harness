import React, { useCallback, useEffect, useState } from 'react';
import { BrainCircuit, Plus, Trash2, X } from 'lucide-react';
import type { MemoryKind, MemoryRecord, MemoryScope } from '../types';

interface MemoryPanelProps { onClose: () => void; hasProject: boolean; }

const kindLabels: Record<MemoryKind, string> = { preference: '偏好', fact: '事实', decision: '决策', todo: '待办', artifact: '产出' };

export function MemoryPanel({ onClose, hasProject }: MemoryPanelProps) {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('preference');
  const [scope, setScope] = useState<MemoryScope>('global');
  const [tags, setTags] = useState('');
  const [autoExtract, setAutoExtract] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await window.amd?.memory?.list();
      setRecords(list ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => {
    void load();
    void window.amd?.memory?.settings().then((settings) => setAutoExtract(Boolean(settings.autoExtract))).catch(() => undefined);
  }, [load]);
  useEffect(() => { if (!hasProject && scope === 'project') setScope('global'); }, [hasProject, scope]);

  const add = async () => {
    if (!content.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      await window.amd?.memory?.add({ content: content.trim(), kind, scope, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) });
      setContent(''); setTags('');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (!window.confirm('删除这条长期记忆？')) return;
    try { await window.amd?.memory?.remove(id); setRecords((current) => current.filter((record) => record.id !== id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const exportAll = async () => {
    try {
      const list = await window.amd?.memory?.exportAll() ?? records;
      const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'newai-memories.json';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const toggleAutoExtract = async () => {
    const next = !autoExtract;
    setAutoExtract(next);
    try { await window.amd?.memory?.setAutoExtract(next); }
    catch (cause) { setAutoExtract(!next); setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const clearAll = async () => {
    if (!records.length || !window.confirm('清空全部长期记忆？此操作不可撤销。')) return;
    try { await window.amd?.memory?.clear(); setRecords([]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return <div className="modal-overlay memory-overlay"><section className="modal-window memory-window" role="dialog" aria-modal="true" aria-labelledby="memory-title">
    <header className="memory-header"><div><div className="eyebrow">LONG-TERM MEMORY</div><h2 id="memory-title">长期记忆</h2><p>跨会话保留偏好、项目事实和决策；记忆会作为数据注入，不会自动变成指令。</p></div><div className="memory-header-actions"><button className="button outline small" disabled={!records.length} onClick={() => void exportAll()}>导出</button><button className="button danger small" disabled={!records.length} onClick={() => void clearAll()}>清空</button><button className="close-button" onClick={onClose} aria-label="关闭长期记忆">×</button></div></header>
    <div className="memory-add">
      <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="例如：这个项目统一使用 pnpm；提交前先运行 npm test" aria-label="记忆内容" rows={2} />
      <div className="memory-add-row">
        <select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)} aria-label="记忆类型">{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select value={scope} onChange={(event) => setScope(event.target.value as MemoryScope)} aria-label="记忆范围"><option value="global">全局</option><option value="project" disabled={!hasProject}>当前项目</option></select>
        <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，用逗号分隔" aria-label="记忆标签" />
        <button className="button primary" disabled={busy || !content.trim()} onClick={() => void add()}><Plus size={14} />保存记忆</button>
      </div>
    </div>
    <label className="memory-auto"><input type="checkbox" checked={autoExtract} onChange={() => void toggleAutoExtract()} /><span><strong>完成后自动提取记忆</strong><small>默认关闭。开启后会额外调用一个低成本模型，从完成的对话中提取最多 3 条长期记忆。</small></span></label>
    {error && <div className="memory-error" role="alert">{error}</div>}
    <div className="memory-list">
      {records.length ? records.map((record) => <article key={record.id} className="memory-item">
        <div className="memory-item-head"><span className={`memory-scope ${record.scope}`}>{record.scope === 'project' ? '项目' : record.scope === 'session' ? '会话' : '全局'}</span><span className="memory-kind">{kindLabels[record.kind] ?? record.kind}</span><span className="memory-date">{new Date(record.updatedAt).toLocaleDateString('zh-CN')}</span><button className="message-icon-button" aria-label="删除记忆" title="删除记忆" onClick={() => void remove(record.id)}><Trash2 size={13} /></button></div>
        <p>{record.content}</p>
        {!!record.tags.length && <div className="memory-tags">{record.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
      </article>) : <div className="memory-empty"><BrainCircuit size={22} /><strong>还没有长期记忆</strong><span>在上面写一条，或让智能体在对话中调用 remember 工具。</span></div>}
    </div>
  </section></div>;
}
