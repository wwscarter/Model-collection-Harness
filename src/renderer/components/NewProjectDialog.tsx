import React, { useEffect, useState } from 'react';
import { Check, FileCode, Folder, FolderPlus, GitBranch, ShieldCheck, Plus, RefreshCw, X } from 'lucide-react';
import type { ProjectInfo } from '../types';
import { errorMessage } from '../format';

type PickedProject = ProjectInfo & { existing: boolean };

interface NewProjectDialogProps {
  onClose: () => void;
  onCreated: (project: ProjectInfo) => void;
}

export function NewProjectDialog({ onClose, onCreated }: NewProjectDialogProps) {
  const [picked, setPicked] = useState<PickedProject>();
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const pick = async () => {
    setError(null);
    try {
      const result = await window.amd?.projects.pickDirectory();
      if (!result) return;
      setPicked(result);
      if (!nameEdited || !name.trim()) { setName(result.name); setNameEdited(false); }
    } catch (cause) { setError(errorMessage(cause)); }
  };
  const submit = async () => {
    if (!picked || !name.trim() || !window.amd) return;
    setBusy(true); setError(null);
    try { onCreated(await window.amd.projects.create({ root: picked.root, name: name.trim() })); }
    catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  };
  const inferred = Boolean(picked) && !nameEdited && !picked?.existing && name === picked?.name;

  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal-window new-project-window" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
      <header className="dialog-header">
        <span className="dialog-icon"><FolderPlus size={18} /></span>
        <div><h2 id="new-project-title">新建项目</h2><p>绑定本地文件夹，任务可以读取文件，并在确认后修改文件、执行命令</p></div>
        <button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="dialog-body">
        <div className="field">
          <div className="field-label"><label htmlFor="project-name">项目名称 <em>*</em></label>{inferred && <span className="field-hint accent"><Check size={12} />已自动推断</span>}{picked?.existing && <span className="field-hint">已在项目列表中</span>}</div>
          <div className="input-with-action"><input id="project-name" className={`input ${inferred ? 'inferred' : ''}`} value={name} maxLength={80} placeholder="例如：newai-agent-core" onChange={(event) => { setName(event.target.value); setNameEdited(true); }} />{name && <button className="input-action" title="清除" aria-label="清除名称" onClick={() => { setName(''); setNameEdited(true); }}><X size={13} /></button>}</div>
          <p className="field-help">显示在工作台左侧「本地项目」列表和顶部状态中，便于快速切换</p>
        </div>
        <div className="field">
          <div className="field-label"><span>绑定本地目录 <em>*</em></span></div>
          {picked ? <div className="directory-row"><div className="directory-path mono" title={picked.root}><Folder size={15} /><span>{picked.displayRoot}</span></div><button className="button outline" onClick={() => void pick()}><RefreshCw size={13} />更换文件夹</button></div>
            : <button className="directory-picker" onClick={() => void pick()}><Folder size={15} />选择本地文件夹…</button>}
        </div>
        {picked && <div className="detection-card">
          <div className="detection-row">
            {picked.git?.branch || picked.git?.detached ? <><span className="branch-chip"><GitBranch size={11} />{picked.git.branch ?? picked.git.head}</span><span>已关联 Git 仓库</span></> : <span className="muted-text">未检测到 Git 仓库</span>}
            <span className="detection-right"><ShieldCheck size={12} />修改与执行需确认</span>
          </div>
          <div className="detection-row divided">
            <span className="detection-left"><FileCode size={13} />{picked.languages.length ? <>检测到 <strong>{picked.languages.join(' / ')}</strong> 项目</> : '未识别到常见项目清单文件'}</span>
            {picked.markers.length > 0 && <span className="mono muted-text">包含 {picked.markers.slice(0, 2).join(', ')}</span>}
          </div>
        </div>}
        {error && <div className="error-banner" role="alert">{error}</div>}
      </div>
      <footer className="dialog-footer">
        <button className="button ghost" onClick={onClose} disabled={busy}>取消</button>
        <button className="button primary" disabled={busy || !picked || !name.trim()} onClick={() => void submit()}><Plus size={14} />{busy ? '正在打开…' : picked?.existing ? '打开项目' : '创建并打开项目'}</button>
      </footer>
    </section>
  </div>;
}
