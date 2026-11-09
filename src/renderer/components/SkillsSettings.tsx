import React, { useEffect, useRef, useState } from 'react';
import { Folder, RefreshCw, Upload } from 'lucide-react';
import { errorMessage } from '../format';
import type { PendingSkillImport, SkillsApi, SkillsListing } from '../skillsTypes';

export function SkillsSettings({ api }: { api: SkillsApi }) {
  const [listing, setListing] = useState<SkillsListing>();
  const [pending, setPending] = useState<PendingSkillImport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  const currentApi = useRef(api);
  currentApi.current = api;
  const active = () => mounted.current && currentApi.current === api;
  const refresh = async () => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try { const next = await api.list(); if (active()) setListing(next); }
    catch (cause) { if (active()) setError(errorMessage(cause)); }
    finally { if (active()) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [api]);
  const perform = async (action: () => Promise<unknown>, success?: string, reload = false) => {
    if (busy) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await action();
      const next = reload ? await api.list() : undefined;
      if (active()) { if (next) setListing(next); if (success) setNotice(success); }
    } catch (cause) { if (active()) setError(errorMessage(cause)); }
    finally { if (active()) setBusy(false); }
  };
  const previewImport = () => perform(async () => { const next = await api.previewImport(); if (active()) setPending(next); });
  const confirmImport = () => pending && perform(async () => { await api.confirmImport(pending.token); if (active()) setPending(undefined); }, '技能已导入，从下一轮任务生效。', true);
  return <div className="runtime-settings" aria-label="技能设置">
    <section className="runtime-card" aria-labelledby="skills-title">
      <div className="runtime-card-heading"><div><h3 id="skills-title">技能</h3><p>查看已安装技能、启用状态和加载诊断，导入前先预览 SKILL.md。</p></div><button type="button" className="button outline small" disabled={busy} onClick={() => void perform(() => api.openDirectory())}><Folder size={13} />打开技能目录</button><button type="button" className="button outline small" disabled={busy || !listing} onClick={() => void previewImport()}><Upload size={13} />从文件夹导入</button><button type="button" className="button ghost small" aria-label="刷新技能列表" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /></button></div>
      {!listing && !error && <p className="runtime-hint" role="status">正在读取技能…</p>}
      {listing && !listing.skills.length && <p className="runtime-hint">尚未安装技能，可打开目录或从本地文件夹导入。</p>}
      {listing?.skills.map((skill) => <article className="form-section" key={skill.path} aria-label={'技能 ' + skill.name}>
        <div className="routing-config-footer"><strong>{skill.name}</strong><label className="field-label"><input type="checkbox" aria-label={'启用技能 ' + skill.name} checked={skill.enabled} disabled={busy} onChange={(event) => void perform(() => api.setEnabled(skill.id, event.target.checked), '技能启用状态已保存，从下一轮任务生效。', true)} />启用</label></div>
        <p className="runtime-hint">{skill.description}</p><p className="runtime-hint mono">{skill.path}</p>
      </article>)}
    </section>
    {pending && <section className="runtime-card" aria-label="技能导入预览">
      <div className="runtime-card-heading"><div><h3>{pending.preview.name}</h3><p>{pending.preview.fileCount} 个文件 · {(pending.preview.totalBytes / 1024).toFixed(1)} KB</p></div></div>
      <pre className="mono" aria-label="SKILL.md 完整内容" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflowY: 'auto', padding: 12, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface-soft)' }}>{pending.preview.content}</pre>
      <p className="runtime-hint">确认后复制到本机技能目录；原文件夹发生变化时需要重新预览。</p>
      <div className="routing-config-footer"><button type="button" className="button primary small" disabled={busy} onClick={() => void confirmImport()}>确认导入技能</button><button type="button" className="button ghost small" disabled={busy} onClick={() => setPending(undefined)}>取消导入</button></div>
    </section>}
    {!!listing?.diagnostics.length && <section className="runtime-card"><h3>加载诊断</h3><ul className="runtime-hint" aria-label="技能加载诊断">{listing.diagnostics.map((message, index) => <li key={index}>{message}</li>)}</ul></section>}
    {error && <div className="runtime-notice" role="alert">{error}{!listing && <button type="button" className="button outline small" disabled={busy} onClick={() => void refresh()}>重新读取</button>}</div>}
    {notice && <div className="runtime-notice" role="status">{notice}</div>}
  </div>;
}
