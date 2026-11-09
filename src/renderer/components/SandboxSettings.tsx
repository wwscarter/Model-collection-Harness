import React, { useEffect, useRef, useState } from 'react';
import { ShieldCheck, Trash2 } from 'lucide-react';
import type { SandboxSettings as SandboxPolicySettings } from '@core/security/SandboxSettings';
import type { SandboxConfiguration } from '../sandboxTypes';
import { errorMessage } from '../format';

const platformLabels: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
const platformLabel = (platform: string) => platformLabels[platform] ?? platform;

export function SandboxSettings() {
  const [configuration, setConfiguration] = useState<SandboxConfiguration>();
  const [draft, setDraft] = useState<SandboxPolicySettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  const load = async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await window.amd!.sandbox.get();
      if (mounted.current) { setConfiguration(result); setDraft(result.settings); }
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  useEffect(() => {
    mounted.current = true;
    if (window.amd?.sandbox) void load();
    return () => { mounted.current = false; };
  }, []);
  if (!window.amd?.sandbox) return null;
  const dirty = draft && configuration && JSON.stringify(draft) !== JSON.stringify(configuration.settings);
  const chooseDirectory = async () => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const directory = await window.amd!.sandbox.pickDirectory();
      if (mounted.current && directory) setDraft((current) => current ? { ...current, writableRoots: [...new Set([...current.writableRoots, directory])] } : current);
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const result = await window.amd!.sandbox.set(draft);
      if (mounted.current) { setConfiguration(result); setDraft(result.settings); setNotice('沙箱设置已保存，新启动的命令使用此设置。'); }
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <section className="runtime-card" aria-labelledby="sandbox-title">
    <div className="runtime-card-heading"><span className="runtime-card-icon"><ShieldCheck size={16} /></span><div><h3 id="sandbox-title">命令沙箱</h3><p>限制命令可写入的目录与网络连接，完全控制模式下仍然生效。</p></div></div>
    {configuration && <p className="runtime-hint" aria-label="命令沙箱状态">{configuration.status.enabled ? '已启用' : '不可用'} · {platformLabel(configuration.status.platform)}{configuration.status.reason && ' · ' + configuration.status.reason}</p>}
    {draft && <form onSubmit={(event) => void save(event)}>
      <fieldset className="routing-config-fields" disabled={busy}>
        <label className="field"><span className="field-label">命令网络策略</span><select className="input" aria-label="命令网络策略" value={draft.network} onChange={(event) => { setDraft({ ...draft, network: event.target.value as SandboxPolicySettings['network'] }); setNotice(undefined); }}>
          <option value="allow">允许网络</option><option value="loopback">仅限本机</option><option value="deny">禁止网络</option>
        </select></label>
        <div className="field"><span className="field-label">额外可写目录</span>
          <p className="runtime-hint">项目目录、临时目录和常见包管理缓存由命令沙箱预置。可添加命令需要写入的其它文件夹。</p>
          {draft.writableRoots.length ? <ul aria-label="额外可写目录">{draft.writableRoots.map((directory) => <li key={directory}><span className="mono">{directory}</span> <button type="button" className="button ghost small" aria-label={'移除可写目录 ' + directory} onClick={() => { setDraft({ ...draft, writableRoots: draft.writableRoots.filter((root) => root !== directory) }); setNotice(undefined); }}><Trash2 size={14} />移除</button></li>)}</ul> : <p className="runtime-hint">尚未添加额外目录。</p>}
          <button type="button" className="button outline small" onClick={() => void chooseDirectory()}>选择可写目录</button>
        </div>
        <div className="routing-config-footer"><button type="submit" className="button primary small" disabled={!dirty}>保存沙箱设置</button></div>
      </fieldset>
    </form>}
    {!configuration && !error && <p className="runtime-hint" role="status">正在读取命令沙箱状态…</p>}
    {error && <div className="runtime-notice" role="alert">{error}{!configuration && <button type="button" className="button outline small" disabled={busy} onClick={() => void load()}>重新读取</button>}</div>}
    {notice && <div className="runtime-notice" role="status">{notice}</div>}
  </section>;
}
