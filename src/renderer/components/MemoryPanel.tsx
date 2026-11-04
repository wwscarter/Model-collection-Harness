import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BrainCircuit, Check, Plus, Trash2, X } from 'lucide-react';
import type { AmdApi, MemoryKind, MemoryRecord, MemoryScope } from '../types';

interface MemoryPanelProps { onClose: () => void; hasProject: boolean; }

const kindLabels: Record<MemoryKind, string> = { preference: '偏好', fact: '事实', decision: '决策', todo: '待办', artifact: '产出' };

export function MemoryPanel({ onClose, hasProject }: MemoryPanelProps) {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('preference');
  const [scope, setScope] = useState<MemoryScope>('global');
  const [tags, setTags] = useState('');
  const [autoExtract, setAutoExtract] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const loadRequest = useRef(0);
  const mutationPending = useRef(false);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      if (!window.amd?.memory) throw new Error('记忆接口尚未连接');
      const list = await window.amd.memory.list();
      if (request !== loadRequest.current) return;
      setRecords(list);
      setSelectedIds((current) => current.filter((id) => list.some((record) => record.id === id)));
    } catch (cause) { if (request === loadRequest.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => {
    let active = true;
    void load();
    void window.amd?.memory?.settings().then((settings) => { if (active) setAutoExtract(Boolean(settings.autoExtract)); }).catch(() => undefined).finally(() => { if (active) setSettingsReady(true); });
    return () => { active = false; loadRequest.current += 1; };
  }, [load]);
  useEffect(() => { if (!hasProject && scope === 'project') setScope('global'); }, [hasProject, scope]);

  const mutate = async (action: (memory: AmdApi['memory']) => Promise<unknown>) => {
    if (mutationPending.current) return;
    mutationPending.current = true; loadRequest.current += 1;
    setBusy(true); setError(null);
    try {
      if (!window.amd?.memory) throw new Error('记忆接口尚未连接');
      await action(window.amd.memory);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { mutationPending.current = false; setBusy(false); }
  };
  const add = async () => {
    if (!content.trim()) return;
    await mutate(async (memory) => {
      await memory.add({ content: content.trim(), kind, scope, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) });
      setContent(''); setTags('');
    });
  };
  const approve = async (id: string) => {
    await mutate((memory) => memory.approve(id));
  };
  const toggleSelect = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const pendingIds = records.filter((record) => record.status === 'pending').map((record) => record.id);
  const allPendingSelected = pendingIds.length > 0 && pendingIds.every((id) => selectedIds.includes(id));
  const selectAllPending = () => setSelectedIds(allPendingSelected ? selectedIds.filter((id) => !pendingIds.includes(id)) : [...new Set([...selectedIds, ...pendingIds])]);
  const selectedPending = selectedIds.filter((id) => pendingIds.includes(id));
  const approveSelected = async () => {
    if (!selectedPending.length) return;
    await mutate((memory) => memory.approveMany(selectedPending));
  };
  const removeSelected = async () => {
    if (!selectedIds.length || !window.confirm(`删除选中的 ${selectedIds.length} 条记忆？`)) return;
    await mutate((memory) => memory.removeMany(selectedIds));
  };
  const remove = async (id: string) => {
    if (!window.confirm('删除这条长期记忆？')) return;
    await mutate((memory) => memory.remove(id));
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
    await mutate(async (memory) => { await memory.setAutoExtract(next); setAutoExtract(next); });
  };
  const clearAll = async () => {
    if (!records.length || !window.confirm('清空全部长期记忆？此操作不可撤销。')) return;
    await mutate((memory) => memory.clear());
  };

  return <div className="modal-overlay memory-overlay"><section className="modal-window memory-window" role="dialog" aria-modal="true" aria-labelledby="memory-title" aria-busy={busy}>
    <header className="memory-header"><div><div className="eyebrow">LONG-TERM MEMORY</div><h2 id="memory-title">长期记忆</h2><p>跨会话保留偏好、项目事实和决策；记忆会作为数据注入，不会自动变成指令。</p></div><div className="memory-header-actions"><button className="button outline small" disabled={!records.length || busy} onClick={() => void exportAll()}>导出</button><button className="button danger small" disabled={!records.length || busy} onClick={() => void clearAll()}>清空</button><button className="close-button" disabled={busy} onClick={onClose} aria-label="关闭长期记忆">×</button></div></header>
    <fieldset className="memory-fields" disabled={busy}>
    <div className="memory-add">
      <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="例如：这个项目统一使用 pnpm；提交前先运行 npm test" aria-label="记忆内容" rows={2} />
      <div className="memory-add-row">
        <select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)} aria-label="记忆类型">{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select value={scope} onChange={(event) => setScope(event.target.value as MemoryScope)} aria-label="记忆范围"><option value="global">全局</option><option value="project" disabled={!hasProject}>当前项目</option></select>
        <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，用逗号分隔" aria-label="记忆标签" />
        <button className="button primary" disabled={busy || !content.trim()} onClick={() => void add()}><Plus size={14} />保存记忆</button>
      </div>
    </div>
    <label className="memory-auto"><input type="checkbox" checked={autoExtract} disabled={!settingsReady} onChange={() => void toggleAutoExtract()} /><span><strong>完成后自动提取记忆</strong><small>默认关闭。开启后会额外调用一个低成本模型，从完成的对话中提取最多 3 条长期记忆；提取结果会先进入待审核。</small></span></label>
    <div className="memory-batch"><label><input type="checkbox" checked={allPendingSelected} disabled={!pendingIds.length} onChange={selectAllPending} />全选待审核（{pendingIds.length}）</label><span>已选 {selectedIds.length}</span><button disabled={!selectedPending.length} onClick={() => void approveSelected()}>通过选中</button><button disabled={!selectedIds.length} onClick={() => void removeSelected()}>删除选中</button></div>
    {error && <div className="memory-error" role="alert">{error}</div>}
    <div className="memory-list">
      {records.length ? records.map((record) => <article key={record.id} className="memory-item">
        <div className="memory-item-head"><input type="checkbox" checked={selectedIds.includes(record.id)} onChange={() => toggleSelect(record.id)} aria-label="选择记忆" /><span className={`memory-scope ${record.scope}`}>{record.scope === 'project' ? '项目' : record.scope === 'session' ? '会话' : '全局'}</span><span className="memory-kind">{kindLabels[record.kind] ?? record.kind}</span>{record.status === 'pending' && <span className="memory-pending">待审核</span>}<span className="memory-date">{new Date(record.updatedAt).toLocaleDateString('zh-CN')}</span>{record.status === 'pending' && <button className="message-icon-button" aria-label="通过记忆" title="通过审核" onClick={() => void approve(record.id)}><Check size={13} /></button>}<button className="message-icon-button" aria-label="删除记忆" title="删除记忆" onClick={() => void remove(record.id)}><Trash2 size={13} /></button></div>
        <p>{record.content}</p>
        {!!record.tags.length && <div className="memory-tags">{record.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
      </article>) : <div className="memory-empty"><BrainCircuit size={22} /><strong>还没有长期记忆</strong><span>在上面写一条，或让智能体在对话中调用 remember 工具。</span></div>}
    </div>
    </fieldset>
  </section></div>;
}
