import React, { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import type { CodeSearchConfig } from '@core/codebase/CodeSearchConfig';
import type { CodebaseConfiguration } from '../codebaseTypes';
import { errorMessage } from '../format';

export function CodeSearchSettings() {
  const [configuration, setConfiguration] = useState<CodebaseConfiguration>();
  const [draft, setDraft] = useState<CodeSearchConfig>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    let active = true;
    void window.amd?.codebase?.get().then((value) => { if (active) { setConfiguration(value); setDraft(value.config); } }).catch((cause) => { if (active) setNotice(errorMessage(cause)); });
    return () => { active = false; };
  }, []);
  const perform = async (action: () => Promise<string>) => {
    setBusy(true); setNotice(undefined);
    try { setNotice(await action()); } catch (cause) { setNotice(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  if (!window.amd?.codebase) return null;
  return <section className="runtime-card" aria-labelledby="code-search-title">
    <div className="runtime-card-heading"><span className="runtime-card-icon"><Search size={16} /></span><div><h3 id="code-search-title">代码检索</h3><p>项目内搜索与符号索引保存在本机；选择项目后自动更新。</p></div></div>
    {draft && <form onSubmit={(event) => { event.preventDefault(); void perform(async () => {
      const saved = await window.amd!.codebase.set(draft);
      setConfiguration(saved); setDraft(saved.config);
      return '代码检索设置已保存，从下一轮任务生效。';
    }); }}>
      <fieldset className="routing-config-fields" disabled={busy}>
        <label className="field"><span><input type="checkbox" aria-label="启用本机语义检索" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> 启用本机语义检索</span></label>
        <p className="runtime-hint">复用本机 Ollama 地址：{configuration?.baseURL}。请选择已有 embedding 模型，代码仅发送到该本机服务。</p>
        <div className="form-grid two">
          <label className="field"><span className="field-label">Embedding 模型</span><input className="input mono" aria-label="Embedding 模型" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="已安装的 embedding 模型 ID" /></label>
          <label className="field"><span className="field-label">每次检索数量</span><input className="input" aria-label="每次检索数量" type="number" min={1} max={50} value={draft.topK} onChange={(event) => setDraft({ ...draft, topK: Number(event.target.value) })} /></label>
        </div>
        <details><summary>索引限额</summary><div className="form-grid two">
          <label className="field"><span className="field-label">最多索引文件</span><input className="input" aria-label="最多索引文件" type="number" min={1} max={10000} value={draft.maxFiles} onChange={(event) => setDraft({ ...draft, maxFiles: Number(event.target.value) })} /></label>
          <label className="field"><span className="field-label">最多代码块</span><input className="input" aria-label="最多代码块" type="number" min={1} max={100000} value={draft.maxChunks} onChange={(event) => setDraft({ ...draft, maxChunks: Number(event.target.value) })} /></label>
          <label className="field"><span className="field-label">本机请求超时（毫秒）</span><input className="input" aria-label="本机请求超时" type="number" min={250} max={120000} value={draft.timeoutMs} onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })} /></label>
        </div></details>
        <div className="routing-config-footer">
          <button type="submit" className="button primary small">保存检索设置</button>
          <button type="button" className="button outline small" disabled={!draft.model.trim()} onClick={() => void perform(async () => { const result = await window.amd!.codebase.probe({ ...draft, enabled: true }); return '本机 embedding 模型可用：' + result.model; })}>检测模型</button>
          <button type="button" className="button outline small" onClick={() => void perform(async () => { const stats = await window.amd!.codebase.reindex(); return '符号索引已更新：' + stats.files + ' 个文件，' + stats.symbols + ' 个符号' + (stats.truncated ? '（已达到扫描限额）' : ''); })}>更新当前项目索引</button>
        </div>
      </fieldset>
    </form>}
    {configuration?.status.reason && (!configuration.config.enabled || configuration.status.status !== 'disabled') && <p className="runtime-hint">{configuration.status.reason}</p>}
    {configuration?.config.enabled && configuration.status.status === 'disabled' && <p className="runtime-hint">语义检索已启用，将在首次使用时建立本机索引。</p>}
    {notice && <div className="runtime-notice" role="status">{notice}</div>}
  </section>;
}
