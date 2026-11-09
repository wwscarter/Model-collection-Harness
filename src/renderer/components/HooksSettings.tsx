import React, { useEffect, useRef, useState } from 'react';
import { Code2, Plus, RefreshCw } from 'lucide-react';
import { validateHookConfig, type HookConfig, type HookDefinition } from '@core/hooks/HookConfig';
import type { HookFile, HooksApi, HooksListing } from '../hooksTypes';
import { errorMessage } from '../format';

const emptyConfig = (): HookConfig => ({ version: 1, hooks: [] });
const serialize = (config: HookConfig): string => JSON.stringify(config, null, 2);
const eventLabels: Record<string, string> = { pre_tool: '工具调用前', post_tool: '工具完成后', run_start: '任务开始', run_end: '任务结束' };
const formatter: HookDefinition = { id: 'format-typescript', event: 'post_tool', enabled: true, match: { tool: ['write', 'edit'], glob: '**/*.{ts,tsx}' }, run: 'npx prettier --write {{files}}', timeoutMs: 15000, onFailure: 'report' };
const blockExample: HookDefinition = { id: 'protect-lockfile', event: 'pre_tool', enabled: true, match: { tool: ['write', 'edit'], glob: 'package-lock.json' }, action: 'block', reason: '请使用包管理器更新 lockfile。' };

function parse(text: string): { config?: HookConfig; error?: string } {
  try { return { config: validateHookConfig(JSON.parse(text)) }; }
  catch (cause) { return { error: errorMessage(cause) }; }
}

export function HooksSettings({ api }: { api: HooksApi }) {
  const [listing, setListing] = useState<HooksListing>();
  const [text, setText] = useState('');
  const [baseline, setBaseline] = useState('');
  const [preview, setPreview] = useState<HookFile>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const editor = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const currentApi = useRef(api);
  currentApi.current = api;
  const active = () => mounted.current && currentApi.current === api;
  const parsed = parse(text);
  const apply = (value: HooksListing) => {
    const content = value.global?.config ? serialize(value.global.config) : value.global?.content || serialize(emptyConfig());
    setListing(value); setText(content); setBaseline(content);
    setPreview((current) => current ? value.project : undefined);
  };
  const refresh = async () => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try { const value = await api.list(); if (active()) apply(value); }
    catch (cause) { if (active()) setError(errorMessage(cause)); }
    finally { if (active()) setBusy(false); }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [api]);
  const change = (next: string) => { setText(next); setError(undefined); setNotice(undefined); };
  const changeConfig = (update: (value: HookConfig) => HookConfig) => { if (parsed.config) change(serialize(update(parsed.config))); };
  const addExample = (example: HookDefinition) => changeConfig((config) => {
    let id = example.id; let suffix = 2;
    while (config.hooks.some((hook) => hook.id === id)) id = example.id + '-' + suffix++;
    return { version: 1, hooks: [...config.hooks, { ...example, id }] };
  });
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!parsed.config || busy) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await api.saveGlobal(parsed.config);
      const next = await api.list();
      if (active()) { apply(next); setNotice('Hooks 已保存，从下一轮任务生效。'); }
    } catch (cause) { if (active()) setError(errorMessage(cause)); }
    finally { if (active()) setBusy(false); }
  };
  const trust = async () => {
    if (!preview || preview.error || !preview.config || busy) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await api.trustProject(preview.hash);
      const next = await api.list();
      if (active()) { setListing(next); setPreview(undefined); setNotice('已信任当前项目 Hooks。'); }
    } catch (cause) { if (active()) setError(errorMessage(cause)); }
    finally { if (active()) setBusy(false); }
  };
  return <div className="runtime-settings" aria-label="Hooks 设置">
    <section className="runtime-card" aria-labelledby="global-hooks-title">
      <div className="runtime-card-heading"><span className="runtime-card-icon"><Code2 size={16} /></span><div><h3 id="global-hooks-title">全局 Hooks</h3><p>用声明式配置在任务与工具事件前后运行命令。命令使用当前沙箱和审批策略。</p></div><button type="button" className="button ghost small" aria-label="重新读取 Hooks" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /></button></div>
      {listing && <form onSubmit={(event) => void save(event)}>
        {listing.global && <p className="runtime-hint mono">{listing.global.path}</p>}
        <fieldset className="routing-config-fields" disabled={busy}>
          <div className="routing-config-footer"><button type="button" className="button outline small" disabled={!parsed.config} onClick={() => addExample(formatter)}><Plus size={13} />添加 TS 格式化示例</button><button type="button" className="button outline small" disabled={!parsed.config} onClick={() => addExample(blockExample)}><Plus size={13} />添加 pre_tool 阻止示例</button></div>
          {parsed.config?.hooks.map((hook, index) => <article className="form-section" key={hook.id} aria-label={'Hook ' + hook.id}>
            <div className="routing-config-footer"><strong>{hook.id}</strong><span className="runtime-hint">{eventLabels[hook.event]} · {hook.event}</span><label className="field-label"><input type="checkbox" aria-label={'启用 Hook ' + hook.id} checked={hook.enabled !== false} onChange={(event) => changeConfig((config) => ({ ...config, hooks: config.hooks.map((item, position) => position === index ? { ...item, enabled: event.target.checked } : item) }))} />启用</label><button type="button" className="button outline small" onClick={() => editor.current?.focus()}>编辑 JSON</button><button type="button" className="button ghost small" onClick={() => changeConfig((config) => ({ ...config, hooks: config.hooks.filter((_, position) => position !== index) }))}>删除</button></div>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{hook.action === 'block' ? '阻止工具：' + hook.reason : hook.run}</pre>
            <p className="runtime-hint">匹配工具：{hook.match?.tool?.join(', ') || '全部'} · 文件：{hook.match?.glob || '全部'} · 超时：{hook.timeoutMs ?? 15000} ms · 失败：{hook.onFailure === 'ignore' ? '忽略报告' : '报告结果'}</p>
          </article>)}
          {!parsed.config?.hooks.length && !parsed.error && <p className="runtime-hint">尚未配置全局 Hooks。可添加示例后编辑。</p>}
          <label className="field"><span className="field-label">声明式 Hooks JSON</span><textarea ref={editor} className="input mono" aria-label="Hooks JSON 配置" rows={12} style={{ height: 'auto', minHeight: 220, resize: 'vertical' }} value={text} onChange={(event) => change(event.target.value)} /></label>
          {parsed.error && <p className="runtime-hint" role="alert">配置诊断：{parsed.error}</p>}
          <p className="runtime-hint">pre_tool 可阻止调用；post_tool 可把失败输出回传给模型。run_start / run_end 用于任务生命周期，不使用工具匹配。连续失败 3 次的 Hook 在本轮停用。工具命令超时范围为 100–60000 ms，默认 15000 ms。</p>
          <p className="runtime-hint">{'{{files}}'} 表示当前工具涉及的文件，由应用校验并转义；请作为独立参数使用。新增、编辑、启停和删除在保存后生效。</p>
          <div className="routing-config-footer"><button type="submit" className="button primary small" disabled={!parsed.config || text === baseline}>保存 Hooks</button><button type="button" className="button ghost small" disabled={!parsed.config} onClick={() => parsed.config && change(serialize(parsed.config))}>格式化 JSON</button></div>
        </fieldset>
      </form>}
      {!listing && !error && <p className="runtime-hint" role="status">正在读取 Hooks…</p>}
    </section>
    <section className="runtime-card" aria-labelledby="project-hooks-title">
      <div className="runtime-card-heading"><div><h3 id="project-hooks-title">当前项目 Hooks</h3><p>查看完整配置并确认后使用；文件内容变化后需要重新信任。</p></div></div>
      {listing && !listing.project && <p className="runtime-hint">当前项目没有 .newai/hooks.json。</p>}
      {listing?.project && <div className="form-section"><div className="routing-config-footer"><span className="mono">{listing.project.path}</span><span className="runtime-hint">{listing.project.error ? '不可用' : listing.project.trusted ? '已信任' : '待信任'}</span><button type="button" className="button outline small" disabled={busy} onClick={() => setPreview(listing.project)}>{listing.project.trusted || listing.project.error ? '查看配置' : '查看并信任'}</button></div>{listing.project.error && <p className="runtime-hint">{listing.project.error}</p>}</div>}
      {preview && <section className="form-section" aria-label="项目 Hooks 预览">
        <p className="runtime-hint mono">{preview.path}</p>
        <pre className="mono" aria-label="项目 Hooks 完整内容" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflowY: 'auto', padding: 12, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface-soft)' }}>{preview.content}</pre>
        {preview.error && <p className="runtime-hint">{preview.error}</p>}
        <div className="routing-config-footer">{!preview.trusted && !preview.error && preview.config && <button type="button" className="button primary small" disabled={busy} onClick={() => void trust()}>确认信任此 Hooks 配置</button>}<button type="button" className="button ghost small" disabled={busy} onClick={() => setPreview(undefined)}>关闭预览</button></div>
      </section>}
    </section>
    {!!listing?.diagnostics.length && <section className="runtime-card"><h3>加载诊断</h3><ul className="runtime-hint" aria-label="Hooks 加载诊断">{listing.diagnostics.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
    {error && <div className="runtime-notice" role="alert">{error}{!listing && <button type="button" className="button outline small" disabled={busy} onClick={() => void refresh()}>重新读取</button>}</div>}
    {notice && <div className="runtime-notice" role="status">{notice}</div>}
  </div>;
}
