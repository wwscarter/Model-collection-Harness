import React, { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { McpServerConfig } from '@earendil-works/pi-coding-agent';
import type { McpApi, McpListing, McpServerView } from '../mcpTypes';
import { errorMessage } from '../format';

interface Draft { name: string; existing: boolean; type: 'stdio' | 'http'; command: string; args: string; cwd: string; url: string; secrets: string; enabled: boolean; original?: McpServerConfig; }
function draftFor(server?: McpServerView): Draft {
  const config = server?.config;
  const http = Boolean(config && 'url' in config);
  return { name: server?.name ?? '', existing: Boolean(server), type: http ? 'http' : 'stdio', command: config && 'command' in config ? config.command : '', args: JSON.stringify(config && 'args' in config ? config.args ?? [] : [], null, 2), cwd: config && 'cwd' in config ? config.cwd ?? '' : '', url: config && 'url' in config ? config.url : '', secrets: JSON.stringify(config && 'url' in config ? config.headers ?? {} : config && 'command' in config ? config.env ?? {} : {}, null, 2), enabled: config?.enabled !== false, original: config };
}
function payload(draft: Draft): McpServerConfig {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(draft.name)) throw new Error('服务器名称须为 1–80 位字母、数字、横线或下划线');
  let secrets: unknown;
  try { secrets = JSON.parse(draft.secrets); } catch { throw new Error('环境变量或请求头必须为有效 JSON 对象'); }
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets) || Object.values(secrets).some((value) => typeof value !== 'string')) throw new Error('环境变量或请求头必须是文本键值表');
  const base = { ...draft.original } as Record<string, unknown>;
  for (const key of ['type', 'command', 'args', 'cwd', 'env', 'url', 'headers']) delete base[key];
  if (draft.type === 'http') {
    if (!draft.url.trim()) throw new Error('请填写 MCP HTTP 地址');
    return { ...base, type: 'http', url: draft.url.trim(), headers: secrets as Record<string, string>, enabled: draft.enabled } as McpServerConfig;
  }
  if (!draft.command.trim()) throw new Error('请填写 MCP 启动命令');
  let args: unknown;
  try { args = JSON.parse(draft.args); } catch { throw new Error('命令参数必须为有效 JSON 数组'); }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('命令参数必须是文本数组');
  delete base.oauth; delete base.auth;
  return { ...base, type: 'stdio', command: draft.command.trim(), args, ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}), env: secrets as Record<string, string>, enabled: draft.enabled } as McpServerConfig;
}

export function McpSettings({ api }: { api: McpApi }) {
  const [listing, setListing] = useState<McpListing>();
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [logs, setLogs] = useState<string[]>();
  const mounted = useRef(true); const currentApi = useRef(api); currentApi.current = api;
  const active = () => mounted.current && currentApi.current === api;
  const refresh = async () => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try { const next = await api.list(); if (active()) setListing(next); }
    catch (cause) { if (active()) setError(errorMessage(cause)); }
    finally { if (active()) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [api]);
  const perform = async (work: () => Promise<string>, reload = false) => {
    if (busy) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const message = await work(); const next = reload ? await api.list() : undefined;
      if (active()) { if (next) setListing(next); setNotice(message); }
    } catch (cause) { if (active()) setError(errorMessage(cause)); }
    finally { if (active()) setBusy(false); }
  };
  const save = (event: React.FormEvent) => {
    event.preventDefault(); if (!draft) return;
    let config: McpServerConfig;
    try { config = payload(draft); } catch (cause) { setError(errorMessage(cause)); return; }
    void perform(async () => { await api.save(draft.name, config); if (active()) setDraft(undefined); return 'MCP 配置已保存，从下一轮任务生效。'; }, true);
  };
  return <div className="runtime-settings" aria-label="MCP 设置">
    <section className="runtime-card" aria-labelledby="mcp-title">
      <div className="runtime-card-heading"><div><h3 id="mcp-title">MCP 服务器</h3><p>本地服务器以当前用户身份运行，平台支持时使用沙箱。测试连接会启动进程或访问服务器地址。</p></div><button type="button" className="button outline small" disabled={busy || !listing} onClick={() => { setDraft(draftFor()); setError(undefined); setNotice(undefined); }}><Plus size={13} />添加服务器</button><button type="button" className="button ghost small" aria-label="刷新 MCP 列表" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /></button></div>
      {listing && <p className="runtime-hint mono">{listing.path}</p>}
      {!listing && !error && <p className="runtime-hint" role="status">正在读取 MCP 配置…</p>}
      {listing && !listing.servers.length && <p className="runtime-hint">尚未配置 MCP 服务器。</p>}
      {listing?.servers.map((server) => <article className="form-section" key={server.name} aria-label={'MCP 服务器 ' + server.name}>
        <div className="routing-config-footer"><strong>{server.name}</strong><span className="runtime-hint">{'url' in server.config ? 'HTTP' : 'stdio'} · {server.config.enabled === false ? '已停用' : '已启用'}</span><button type="button" className="button outline small" disabled={busy} onClick={() => { setDraft(draftFor(server)); setError(undefined); setNotice(undefined); }}>编辑</button><button type="button" className="button outline small" disabled={busy} onClick={() => void perform(async () => { const result = await api.test(server.name); if (!result.success) throw new Error(result.error || 'MCP 连接测试失败'); const count = result.toolCount ?? (Array.isArray(result.tools) ? result.tools.length : result.tools); return '连接成功：' + server.name + (count === undefined ? '' : ' · ' + count + ' 个工具'); })}>测试连接</button><button type="button" className="button ghost small" disabled={busy} onClick={() => void perform(async () => { await api.remove(server.name); if (active() && draft?.name === server.name) setDraft(undefined); return 'MCP 服务器已删除。'; }, true)}>删除</button></div>
        <p className="runtime-hint mono">{'url' in server.config ? server.config.url : [server.config.command, ...(server.config.args ?? [])].join(' ')}</p>
        {server.error && <p className="runtime-hint">{server.error}</p>}
      </article>)}
      {draft && <form onSubmit={save} aria-label="编辑 MCP 服务器"><fieldset className="routing-config-fields" disabled={busy}>
        <div className="form-grid two"><label className="field"><span className="field-label">服务器名称</span><input className="input" aria-label="MCP 服务器名称" value={draft.name} disabled={draft.existing} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label className="field"><span className="field-label">传输方式</span><select className="input" aria-label="MCP 传输方式" value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as Draft['type'], secrets: '{}' })}><option value="stdio">stdio 本地进程</option><option value="http">HTTP 服务</option></select></label></div>
        {draft.type === 'stdio' ? <><label className="field"><span className="field-label">启动命令</span><input className="input mono" aria-label="MCP 启动命令" value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} /></label><label className="field"><span className="field-label">命令参数（JSON 数组）</span><textarea className="input mono" aria-label="MCP 命令参数" value={draft.args} rows={3} style={{ height: 'auto' }} onChange={(event) => setDraft({ ...draft, args: event.target.value })} /></label><label className="field"><span className="field-label">工作目录（可选）</span><input className="input mono" aria-label="MCP 工作目录" value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} /></label></> : <label className="field"><span className="field-label">HTTP 地址</span><input className="input mono" aria-label="MCP HTTP 地址" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>}
        <label className="field"><span className="field-label">{draft.type === 'http' ? '请求头' : '环境变量'}（JSON 键值表）</span><textarea className="input mono" aria-label="MCP 环境变量或请求头" value={draft.secrets} rows={5} style={{ height: 'auto' }} onChange={(event) => setDraft({ ...draft, secrets: event.target.value })} /></label>
        <p className="runtime-hint">已保存的值以 •••••• 显示；保留掩码即保留原值。把值设为空文本或删除该键会移除它。新输入的值在保存后加密存储。</p>
        <label className="field-label"><input type="checkbox" aria-label="启用 MCP 服务器" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用服务器</label>
        <div className="routing-config-footer"><button type="submit" className="button primary small">保存 MCP 服务器</button><button type="button" className="button ghost small" onClick={() => setDraft(undefined)}>取消编辑</button></div>
      </fieldset></form>}
    </section>
    <section className="runtime-card"><div className="runtime-card-heading"><div><h3>MCP 日志</h3><p>显示本机日志最近 200 行。</p></div><button type="button" className="button outline small" disabled={busy} onClick={() => void perform(async () => { const lines = await api.log(); if (active()) setLogs(lines.slice(-200)); return 'MCP 日志已更新。'; })}>读取日志</button></div>{logs && <pre className="mono" aria-label="MCP 日志内容" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflowY: 'auto' }}>{logs.join('\n') || '暂无日志。'}</pre>}</section>
    {!!listing?.diagnostics.length && <section className="runtime-card"><h3>加载诊断</h3><ul className="runtime-hint" aria-label="MCP 加载诊断">{listing.diagnostics.map((message, index) => <li key={index}>{message}</li>)}</ul></section>}
    {error && <div className="runtime-notice" role="alert">{error}{!listing && <button type="button" className="button outline small" disabled={busy} onClick={() => void refresh()}>重新读取</button>}</div>}
    {notice && <div className="runtime-notice" role="status">{notice}</div>}
  </div>;
}
