import React, { useEffect, useRef, useState } from 'react';
import { FileText, Plus, RefreshCw } from 'lucide-react';
import { errorMessage } from '../format';
import type { GlobalRuleDraft, RuleEntry, RulesApi, RulesListing } from '../rulesTypes';

export function RulesSettings({ api }: { api: RulesApi }) {
  const [listing, setListing] = useState<RulesListing>();
  const [draft, setDraft] = useState<GlobalRuleDraft>();
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<RuleEntry>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  const currentApi = useRef(api);
  currentApi.current = api;
  const active = () => mounted.current && currentApi.current === api;
  const applyListing = (next: RulesListing) => {
    setListing(next);
    setPreview((current) => current ? next.project.find((rule) => rule.path === current.path) : undefined);
  };
  const refresh = async () => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try { const next = await api.list(); if (active()) applyListing(next); }
    catch (cause) { if (active()) setError(errorMessage(cause)); }
    finally { if (active()) setBusy(false); }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [api]);
  const perform = async (action: () => Promise<unknown>, message: string, after?: () => void) => {
    if (busy) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await action();
      const next = await api.list();
      if (active()) { applyListing(next); after?.(); setNotice(message); }
    } catch (cause) { if (active()) setError(errorMessage(cause)); }
    finally { if (active()) setBusy(false); }
  };
  const edit = (rule?: RuleEntry) => {
    setDraft(rule ? { name: rule.name, content: rule.content, enabled: rule.enabled } : { name: '', content: '', enabled: true });
    setEditing(Boolean(rule)); setError(undefined); setNotice(undefined);
  };
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || !draft.name.trim() || !draft.content.trim()) return;
    void perform(() => api.saveGlobal({ ...draft, name: draft.name.trim() }), '全局规则已保存。', () => setDraft(undefined));
  };
  return <div className="runtime-settings" aria-label="规则设置">
    <section className="runtime-card" aria-labelledby="global-rules-title">
      <div className="runtime-card-heading"><span className="runtime-card-icon"><FileText size={16} /></span><div><h3 id="global-rules-title">全局规则</h3><p>在所有项目中使用的工作约定，保存在本机规则目录。</p></div><button type="button" className="button outline small" disabled={busy || !listing} onClick={() => edit()}><Plus size={13} />新建规则</button><button type="button" className="button ghost small" aria-label="刷新规则列表" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /></button></div>
      {!listing && !error && <p className="runtime-hint" role="status">正在读取规则…</p>}
      {listing && !listing.global.length && <p className="runtime-hint">尚未创建全局规则。</p>}
      {listing?.global.map((rule) => <article className="form-section" key={rule.path} aria-label={'全局规则 ' + rule.name}>
        <div className="routing-config-footer"><strong>{rule.name}</strong><span className="runtime-hint">已信任</span><label className="field-label"><input type="checkbox" aria-label={'启用规则 ' + rule.name} checked={rule.enabled} disabled={busy} onChange={(event) => void perform(() => api.setEnabled(rule.name, event.target.checked), '规则启用状态已保存。')} />启用</label><button type="button" className="button outline small" disabled={busy} onClick={() => edit(rule)}>编辑</button><button type="button" className="button ghost small" disabled={busy} onClick={() => void perform(() => api.removeGlobal(rule.name), '全局规则已删除。', () => { if (draft?.name === rule.name) setDraft(undefined); })}>删除</button></div>
        <p className="runtime-hint mono">{rule.path}</p>
        {rule.blocked && <p className="runtime-hint">未加载：{rule.blocked}</p>}
      </article>)}
      {draft && <form onSubmit={save} aria-label={editing ? '编辑全局规则' : '新建全局规则'}>
        <fieldset className="routing-config-fields" disabled={busy}>
          <label className="field"><span className="field-label">规则文件名</span><input className="input mono" aria-label="规则文件名" value={draft.name} maxLength={120} disabled={editing} placeholder="working-conventions.md" onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label className="field"><span className="field-label">规则内容</span><textarea className="input mono" aria-label="规则内容" rows={8} style={{ height: 'auto', minHeight: 160, resize: 'vertical' }} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>
          <label className="field-label"><input type="checkbox" aria-label="保存后启用规则" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />保存后启用</label>
          <div className="routing-config-footer"><button type="submit" className="button primary small" disabled={!draft.name.trim() || !draft.content.trim()}>保存规则</button><button type="button" className="button ghost small" onClick={() => setDraft(undefined)}>取消编辑</button></div>
        </fieldset>
      </form>}
    </section>
    <section className="runtime-card" aria-labelledby="project-rules-title">
      <div className="runtime-card-heading"><div><h3 id="project-rules-title">当前项目规则</h3><p>先查看项目规则全文，再决定是否信任当前内容。文件变化后需要重新确认。</p></div></div>
      {listing && !listing.project.length && <p className="runtime-hint">当前项目没有可用规则。</p>}
      {listing?.project.map((rule) => <article className="form-section" key={rule.path} aria-label={'项目规则 ' + rule.name}>
        <div className="routing-config-footer"><strong>{rule.name}</strong><span className="runtime-hint">{rule.blocked ? '未加载' : rule.trusted ? '已信任' : '待信任'}{!rule.enabled ? ' · 已禁用' : ''}</span><button type="button" className="button outline small" disabled={busy} onClick={() => { setPreview(rule); setError(undefined); setNotice(undefined); }}>{rule.trusted || rule.blocked ? '查看规则' : '查看并信任'}</button></div>
        <p className="runtime-hint mono">{rule.path}</p>
        {rule.blocked && <p className="runtime-hint">{rule.blocked}</p>}
      </article>)}
      {preview && <section className="form-section" aria-label="项目规则预览">
        <h4>{preview.name}</h4><p className="runtime-hint mono">{preview.path}</p>
        {preview.blocked && <p className="runtime-hint">无法加载此规则：{preview.blocked}</p>}
        <pre className="mono" aria-label="项目规则完整内容" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflowY: 'auto', padding: 12, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface-soft)' }}>{preview.content}</pre>
        <div className="routing-config-footer">{!preview.trusted && !preview.blocked && <button type="button" className="button primary small" disabled={busy} onClick={() => void perform(() => api.trustProject(preview.path, preview.hash), '已信任当前项目规则。', () => setPreview(undefined))}>确认信任此内容</button>}<button type="button" className="button ghost small" disabled={busy} onClick={() => setPreview(undefined)}>关闭预览</button></div>
      </section>}
    </section>
    {listing?.truncated && <div className="runtime-notice" role="status">规则已达到容量限制，部分内容或文件未被加载，请查看下方诊断。</div>}
    {!!listing?.diagnostics.length && <section className="runtime-card"><h3>加载诊断</h3><ul className="runtime-hint" aria-label="规则加载诊断">{listing.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}</ul></section>}
    {error && <div className="runtime-notice" role="alert">{error}{!listing && <button type="button" className="button outline small" disabled={busy} onClick={() => void refresh()}>重新读取</button>}</div>}
    {notice && <div className="runtime-notice" role="status">{notice}</div>}
  </div>;
}
