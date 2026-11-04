import React, { useEffect, useState } from 'react';
import { Waypoints, X } from 'lucide-react';

interface RoutingPanelProps { onClose: () => void; }

export function RoutingPanel({ onClose }: RoutingPanelProps) {
  const [path, setPath] = useState('');
  const [text, setText] = useState('');
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.amd?.routingRules?.get().then((value) => { setPath(value.path); setText(value.text); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const save = async () => {
    setBusy(true); setError(null); setSaved(false); setDiagnostics([]);
    try {
      const result = await window.amd?.routingRules?.set(text);
      setDiagnostics(result?.diagnostics ?? []);
      setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return <div className="modal-overlay routing-overlay"><section className="modal-window routing-window" role="dialog" aria-modal="true" aria-labelledby="routing-title">
    <header className="routing-header"><div><div className="eyebrow">ROUTING POLICY</div><h2 id="routing-title"><Waypoints size={17} />路由规则</h2><p>规则在每次新任务开始时生效；只从已启用、有凭据、未超配额的模型中选择。</p></div><button className="close-button" onClick={onClose} aria-label="关闭路由规则">×</button></header>
    <div className="routing-path mono">{path || '正在读取…'}</div>
    <textarea className="routing-editor mono" value={text} onChange={(event) => { setText(event.target.value); setSaved(false); }} spellCheck={false} aria-label="路由规则 JSON" />
    {error && <div className="memory-error" role="alert">{error}</div>}
    {!!diagnostics.length && <div className="routing-diagnostics"><strong>已保存，但有规则被忽略：</strong>{diagnostics.map((message, index) => <div key={index}>{message}</div>)}</div>}
    {saved && !diagnostics.length && <div className="routing-saved">规则已保存，将从下一个任务开始生效。</div>}
    <footer className="routing-footer"><span>支持 taskTypes / complexity / promptKeywords 与 primaryModelId / strategy / fallbackModelIds / collaboratorModelIds。</span><div><button className="button outline" onClick={onClose}>取消</button><button className="button primary" disabled={busy} onClick={() => void save()}>{busy ? '校验中…' : '保存并生效'}</button></div></footer>
  </section></div>;
}
