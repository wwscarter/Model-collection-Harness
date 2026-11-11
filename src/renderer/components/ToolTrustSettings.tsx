import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { errorMessage } from '../format';
import type { ToolTrustApi, ToolTrustListing, ToolTrustMode } from '../toolTrustTypes';

const modeControlled = new Set(['run_command', 'write', 'edit', 'materialize_asset']);
const sourceLabel = (source: string) => source === 'builtin' ? '内置工具' : source === 'mcp' ? 'MCP 工具' : source;

export function ToolTrustSettings({ api }: { api: ToolTrustApi }) {
  const [listing, setListing] = useState<ToolTrustListing>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  const currentApi = useRef(api);
  currentApi.current = api;
  const active = () => mounted.current && currentApi.current === api;
  const refresh = async () => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try { const next = await api.get(); if (active()) setListing(next); }
    catch (cause) { if (active()) setError(errorMessage(cause)); }
    finally { if (active()) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [api]);
  const choose = async (name: string, trust: ToolTrustMode) => {
    if (busy) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await api.set(name, trust);
      const next = await api.get();
      if (active()) { setListing(next); setNotice(name + ' 的工具信任已保存。'); }
    } catch (cause) { if (active()) setError(errorMessage(cause)); }
    finally { if (active()) setBusy(false); }
  };
  return <div className="runtime-settings" aria-label="工具信任设置">
    <section className="runtime-card" aria-labelledby="tool-trust-title">
      <div className="runtime-card-heading"><div><h3 id="tool-trust-title">工具信任</h3><p>按工具设置确认方式。命令和文件写入工具的自动批准由运行权限模式统一管理。</p></div><button type="button" className="button ghost small" aria-label="刷新工具信任" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /></button></div>
      {!listing && !error && <p className="runtime-hint" role="status">正在读取工具…</p>}
      {listing && !listing.tools.length && <p className="runtime-hint">当前没有可配置的工具。</p>}
      {listing?.tools.map((tool) => <article className="form-section" key={tool.name} aria-label={'工具 ' + tool.name}>
        <div className="routing-config-footer"><strong className="mono">{tool.name}</strong><span className="runtime-hint">{sourceLabel(tool.source)}</span><label className="field-label">调用策略<select className="input" aria-label={'工具信任 ' + tool.name} value={tool.trust ?? 'default'} disabled={busy} onChange={(event) => void choose(tool.name, event.target.value as ToolTrustMode)}>
          {!tool.trust && <option value="default" disabled>使用默认审批</option>}
          <option value="ask">总是询问</option><option value="auto" disabled={modeControlled.has(tool.name)}>自动允许</option><option value="disabled">禁用</option>
        </select></label></div>
        {modeControlled.has(tool.name) && <p className="runtime-hint">自动批准由“运行与权限”的执行权限模式控制。</p>}
      </article>)}
    </section>
    {!!listing?.diagnostics.length && <section className="runtime-card"><h3>加载诊断</h3><ul className="runtime-hint" aria-label="工具信任加载诊断">{listing.diagnostics.map((message, index) => <li key={index}>{message}</li>)}</ul></section>}
    {error && <div className="runtime-notice" role="alert">{error}{!listing && <button type="button" className="button outline small" disabled={busy} onClick={() => void refresh()}>重新读取</button>}</div>}
    {notice && <div className="runtime-notice" role="status">{notice}</div>}
  </div>;
}
