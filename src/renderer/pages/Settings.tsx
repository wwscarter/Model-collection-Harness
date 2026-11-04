import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, Check, ChevronDown, CircleCheck, CloudDownload, Eye, EyeOff, LoaderCircle, Plus, Radio, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Trash2, X, Zap } from 'lucide-react';
import type { ModelConfig } from '../types';
import { RuntimeSettings } from '../components/RuntimeSettings';
import { errorMessage } from '../format';
import { capabilityLabels, categoryLabels, createSettingsDraft, providerDefaults, settingsPayload } from '../settingsForm';
import type { ProviderCategory, SettingsDraft } from '../settingsForm';
import '../styles/settings.css';

interface SettingsProps { models: ModelConfig[]; onClose: () => void; onModelsChanged: (models: ModelConfig[]) => void; onOpenRouting: () => void; }
type Busy = 'saving' | 'testing' | 'fetching' | 'refreshing' | null;
type ConnectionResult = { success: boolean; latency?: number; error?: string; demo?: boolean };
type TestedEndpoint = { fingerprint: string; result: ConnectionResult };
const providerInitials: Record<string, string> = { openai: 'OA', anthropic: 'AN', google: 'GG', deepseek: 'DS' };
const initials = (provider: string, name: string) => providerInitials[provider] ?? (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'AI');
const unwrap = (result: unknown) => ((result as { model?: ModelConfig }).model ?? result) as ModelConfig;
const fingerprint = (draft: SettingsDraft) => JSON.stringify([draft.provider, draft.baseURL, draft.apiKey, draft.modelId, draft.temperature, draft.enableThinking]);
const modelDescription = (id: string) => /reason|thinking|\br1\b/i.test(id) ? '推理与深度思考' : /cod(e|er|ing)/i.test(id) ? '代码生成与开发' : /chat/i.test(id) ? '通用对话与日常任务' : '端点提供的模型';
const endpointOrigin = (provider: string, baseURL?: string) => {
  try { return new URL(baseURL?.trim() || providerDefaults[provider] || '').origin; } catch { return ''; }
};

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return <label className="field"><span className="field-label"><span>{label}</span>{hint && <small>{hint}</small>}</span>{children}</label>;
}

export function Settings({ models, onClose, onModelsChanged, onOpenRouting }: SettingsProps) {
  const [tab, setTab] = useState<'models' | 'runtime'>('models');
  const firstModel = models.find((model) => model.isPrimary && model.enabled) ?? models[0];
  const [selectedId, setSelectedId] = useState<string | null>(firstModel?.id ?? null);
  const selected = models.find((model) => model.id === selectedId);
  const [draft, setDraft] = useState<SettingsDraft>(() => createSettingsDraft(firstModel));
  const [query, setQuery] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [tests, setTests] = useState<Record<string, TestedEndpoint>>({});
  const [modelSource, setModelSource] = useState<'saved' | 'fetched' | 'manual'>('saved');
  const [manualEntry, setManualEntry] = useState(false);
  const [manualModel, setManualModel] = useState('');
  const [routing, setRouting] = useState<{ backend: string; available: boolean }>();
  const drafts = useRef<Record<string, SettingsDraft>>({});
  const dialogRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const manualRef = useRef<HTMLInputElement>(null);
  const current = useRef({ onClose, busy });
  current.current = { onClose, busy };
  const selectedKey = selectedId ?? 'new';
  const currentFingerprint = fingerprint(draft);
  const tested = tests[selectedKey];
  const result = tested?.fingerprint === currentFingerprint ? tested.result : undefined;
  const supportsThinking = draft.provider === 'deepseek';
  const dirty = JSON.stringify(draft) !== JSON.stringify(createSettingsDraft(selected));
  const categoryLabel = categoryLabels[draft.providerCategory];
  const categoryValue = draft.providerCategory === 'official' ? 'official:' + draft.provider : draft.providerCategory;
  const sameProvider = selected?.provider === draft.provider && (selected.providerCategory ?? (selected.provider === 'custom' ? 'compatible_gateway' : 'official')) === draft.providerCategory;
  const sameOrigin = Boolean(selected) && endpointOrigin(selected!.provider, selected!.baseURL) === endpointOrigin(draft.provider, draft.baseURL);
  const hasSavedKey = sameProvider && sameOrigin && selected?.hasApiKey;

  useEffect(() => {
    void window.amd?.routingStatus().then(setRouting).catch(() => undefined);
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (current.current.busy !== 'saving') current.current.onClose();
      }
      if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? []).filter((element) => element.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previousFocus?.focus(); };
  }, []);
  useEffect(() => { if (manualEntry) manualRef.current?.focus(); }, [manualEntry]);

  const visibleModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? models.filter((model) => [model.name, model.modelId, model.baseURL, model.provider, categoryLabels[model.providerCategory ?? (model.provider === 'custom' ? 'compatible_gateway' : 'official')]].some((value) => value?.toLowerCase().includes(needle))) : models;
  }, [models, query]);
  const change = (updates: Partial<SettingsDraft>) => { setDraft((value) => ({ ...value, ...updates })); setNotice(null); };
  const switchEndpoint = (model?: ModelConfig) => {
    if (busy) return;
    drafts.current[selectedKey] = draft;
    const key = model?.id ?? 'new';
    setSelectedId(model?.id ?? null);
    setDraft(drafts.current[key] ?? createSettingsDraft(model));
    setNotice(null); setShowKey(false); setManualEntry(false); setManualModel(''); setModelSource('saved');
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const changeCategory = (value: string) => {
    if (value.startsWith('official:')) {
      const provider = value.slice('official:'.length);
      change({ provider, providerCategory: 'official', baseURL: providerDefaults[provider], apiKey: '', availableModels: [], modelId: '', primary: false, temperature: provider === 'anthropic' ? Math.min(draft.temperature, 1) : draft.temperature });
    } else {
      const providerCategory = value as ProviderCategory;
      change({ provider: 'custom', providerCategory, baseURL: providerCategory === 'local_ollama' ? 'http://127.0.0.1:11434/v1' : draft.provider === 'custom' ? draft.baseURL : '', apiKey: '', availableModels: [], modelId: '', primary: false });
    }
    setModelSource('saved');
  };
  const connectionInput = () => ({ id: sameProvider ? selectedId ?? undefined : undefined, provider: draft.provider, baseURL: draft.baseURL.trim(), ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) });
  const needBridge = () => { if (!window.amd) throw new Error('请在桌面应用中使用模型配置功能'); return window.amd; };
  const fetchModels = async () => {
    setBusy('fetching'); setNotice(null);
    try {
      const response = await needBridge().models.fetchModels(connectionInput());
      const ids = [...new Set(response.models.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))];
      if (!ids.length) throw new Error('端点未返回可用模型，可手动添加模型 ID');
      setDraft((value) => ({ ...value, availableModels: ids, modelId: ids.includes(value.modelId) ? value.modelId : ids[0] }));
      setModelSource('fetched');
      setNotice({ tone: 'success', text: '已从端点获取 ' + ids.length + ' 个模型，保存配置后生效。' });
    } catch (cause) { setNotice({ tone: 'error', text: '获取模型失败：' + errorMessage(cause) }); }
    finally { setBusy(null); }
  };
  const testConnection = async () => {
    setBusy('testing'); setNotice(null);
    try {
      if (!draft.modelId.trim()) throw new Error('请先选择或添加模型 ID');
      const response = await needBridge().models.testConnection({ ...connectionInput(), modelId: draft.modelId.trim(), temperature: draft.temperature, enableThinking: draft.enableThinking, contextWindow: Number(draft.contextWindow) });
      setTests((value) => ({ ...value, [selectedKey]: { fingerprint: currentFingerprint, result: response } }));
      if (!response.success) setNotice({ tone: 'error', text: response.demo ? '未验证真实端点：当前没有已保存的 API Key。' : '连接失败：' + (response.error || '端点没有返回有效响应') });
      else setNotice({ tone: 'success', text: response.demo ? '当前为本地演示模式，请配置密钥后验证真实连接。' : '连接成功 · ' + (response.latency ?? 0) + 'ms，已验证当前表单中的端点与模型。' });
    } catch (cause) { setNotice({ tone: 'error', text: errorMessage(cause) }); }
    finally { setBusy(null); }
  };
  const refresh = async () => {
    setBusy('refreshing'); setNotice(null);
    try {
      const api = needBridge();
      const [updated, status] = await Promise.all([api.models.list(), api.routingStatus()]);
      onModelsChanged(updated); setRouting(status);
      setNotice({ tone: 'success', text: '端点列表与路由状态已刷新，当前草稿已保留。' });
    } catch (cause) { setNotice({ tone: 'error', text: errorMessage(cause) }); }
    finally { setBusy(null); }
  };
  const addManualModel = () => {
    const id = manualModel.trim();
    if (!id) return;
    change({ modelId: id, availableModels: [...new Set([...draft.availableModels, id])] });
    setModelSource('manual'); setManualModel(''); setManualEntry(false);
  };
  const removeSelected = async () => {
    if (!selected || busy) return;
    if (!window.confirm(`删除模型「${selected.name}」？此操作不可撤销，相关会话仍会保留已有回复。`)) return;
    setBusy('saving'); setNotice(null);
    try {
      await needBridge().models.delete(selected.id);
      onModelsChanged(models.filter((model) => model.id !== selected.id));
      onClose();
    } catch (cause) {
      setNotice({ tone: 'error', text: '删除失败：' + errorMessage(cause) });
      setBusy(null);
    }
  };
  const save = async () => {
    setNotice(null);
    let payload: Omit<ModelConfig, 'id'>;
    try { payload = settingsPayload(draft, Boolean(selected)); }
    catch (cause) { setNotice({ tone: 'error', text: errorMessage(cause) }); return; }
    setBusy('saving');
    try {
      const api = needBridge();
      const saved = selected ? unwrap(await api.models.update(selected.id, { ...payload, ...(!sameProvider && !draft.apiKey.trim() ? { apiKey: '' } : {}) })) : unwrap(await api.models.register(payload));
      const replace = (model: ModelConfig) => model.id === saved.id ? saved : saved.isPrimary ? { ...model, isPrimary: false } : model;
      const updated = selected ? models.map(replace) : [saved, ...models.map(replace)];
      onModelsChanged(updated); onClose();
    } catch (cause) { setNotice({ tone: 'error', text: '保存失败：' + errorMessage(cause) }); }
    finally { setBusy(null); }
  };
  const status = result ? result.demo ? { tone: 'warn', text: '本地演示模式' } : result.success ? { tone: '', text: '连接正常 · ' + (result.latency ?? 0) + 'ms' } : { tone: 'danger', text: '连接失败' } : { tone: 'muted', text: selected ? '尚未测试当前配置' : '新端点 · 待配置' };
  const numberInput = (key: 'contextWindow' | 'maxTokens' | 'intelligenceScore' | 'priority' | 'inputPrice' | 'outputPrice' | 'requestsPerMinute' | 'tokensPerDay', props: React.InputHTMLAttributes<HTMLInputElement> = {}) => <input className="input mono" type="number" value={draft[key]} onChange={(event) => change({ [key]: event.target.value })} {...props} />;

  return <div className="modal-overlay settings-overlay">
    <section ref={dialogRef} className="modal-window settings-window" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
      <header className="settings-titlebar">
        <div className="titlebar-left"><span className="titlebar-symbol"><SlidersHorizontal size={14} /></span><h2 id="settings-title">设置 <span className="settings-title-english">(Settings)</span></h2></div>
        <div className="titlebar-right"><span className="kbd-hint"><kbd>Esc</kbd>关闭</span><button className="icon-button" aria-label="关闭设置" disabled={busy === 'saving'} onClick={onClose}><X size={16} /></button></div>
      </header>
      <div className="settings-tabs" role="tablist" aria-label="设置分类"><button className={tab === 'models' ? 'active' : ''} role="tab" aria-selected={tab === 'models'} onClick={() => setTab('models')}>模型与端点</button><button className={tab === 'runtime' ? 'active' : ''} role="tab" aria-selected={tab === 'runtime'} onClick={() => setTab('runtime')}>运行与权限</button></div>
      {tab === 'runtime' ? <RuntimeSettings onOpenRouting={onOpenRouting} /> : <div className="settings-body">
        <aside className="endpoint-list" aria-label="端点与路由">
          <div className="endpoint-list-head">
            <div className="endpoint-list-title"><strong>端点与路由</strong><span className="count-pill accent endpoint-ready-count">{models.filter((model) => model.enabled).length} 个启用</span><button className="button primary small" disabled={Boolean(busy)} onClick={() => switchEndpoint()}><Plus size={13} />添加模型</button></div>
            <label className="search-box"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型、URL 或通道…" aria-label="搜索模型、URL 或通道" /></label>
          </div>
          <div className="endpoint-items">
            {visibleModels.map((model) => {
              const test = tests[model.id];
              const result = test?.fingerprint === fingerprint(createSettingsDraft(model)) ? test.result : undefined;
              return <button key={model.id} className={'endpoint-item ' + (selectedId === model.id ? 'selected ' : '') + (model.enabled ? '' : 'is-disabled')} disabled={Boolean(busy)} aria-pressed={selectedId === model.id} onClick={() => switchEndpoint(model)}>
                <span className={'avatar ' + model.provider}>{initials(model.provider, model.name)}</span>
                <span className="endpoint-copy">
                  <span className="endpoint-name"><strong>{model.name}</strong>{result?.success && !result.demo ? <span className="latency mono"><Zap size={10} />{result.latency ?? 0}ms</span> : result && !result.success ? <span className="latency bad">失败</span> : <i className={'state-dot ' + (model.enabled ? 'on' : '')} />}</span>
                  <span className="endpoint-url mono">{model.baseURL || providerDefaults[model.provider] || '自定义端点'}</span>
                  <span className="endpoint-tags">{model.isPrimary && model.enabled && (model.hasApiKey || model.provider === 'custom') && <span className="tag solid">● 使用中</span>}<span className="tag">{categoryLabels[model.providerCategory ?? (model.provider === 'custom' ? 'compatible_gateway' : 'official')]}</span>{model.credentialError ? <span className="tag solid">凭据需重新输入</span> : !model.hasApiKey && model.provider !== 'custom' ? <span className="tag">未配置 Key · 不参与路由</span> : model.availableModels?.length ? <span className="endpoint-model-count">{model.availableModels.length} 个模型</span> : !model.enabled ? <span className="endpoint-model-count">未启用</span> : null}</span>
                </span>
              </button>;
            })}
            {!visibleModels.length && <div className="empty-models"><Radio size={24} /><strong>{models.length ? '没有匹配的端点' : '连接你的第一个模型'}</strong><span>{models.length ? '试试模型名称、地址或通道类别' : '点击“添加模型”，配置 API 或本地服务'}</span>{query && <button onClick={() => setQuery('')}>清空搜索</button>}</div>}
          </div>
          <div className="endpoint-list-foot"><span><i className="live-dot" />{routing?.backend === 'local-model' && routing.available ? '本地路由模型运行中' : routing ? '自动路由引擎运行中' : '正在读取路由状态…'}</span><button className="icon-button endpoint-refresh" aria-label="刷新端点与路由状态" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={13} className={busy === 'refreshing' ? 'spinning' : ''} /></button></div>
        </aside>
        <main className="endpoint-detail">
          <div className="detail-head">
            <span className="avatar solid">{selected ? initials(draft.provider, draft.name) : <Plus size={17} />}</span>
            <div className="detail-head-copy"><div className="detail-title"><h3>{draft.name || '添加模型端点'}</h3><span className={'status-pill settings-connection-badge ' + status.tone}><i className="live-dot" />{busy === 'testing' ? '正在测试连接…' : status.text}</span></div><p className="mono">{draft.modelId ? 'ID: ' + draft.modelId + ' · ' + categoryLabel : '配置一个端点，让合适的模型随时就绪'}</p></div>
            <button className={'button ' + (draft.primary ? 'primary' : 'outline')} disabled={Boolean(busy)} title={draft.primary ? '点击恢复自动路由，保存后生效' : '固定使用此模型执行任务，保存后生效'} onClick={() => { change({ primary: !draft.primary, ...(draft.primary ? {} : { enabled: true }) }); setNotice({ tone: 'success', text: draft.primary ? '保存后恢复自动路由。' : '保存后将此模型设为主力路由。' }); }}><CircleCheck size={14} />{draft.primary ? selected?.isPrimary && !dirty ? '主力路由 / 使用中' : '主力路由 · 待保存' : '设为主力路由'}</button>
          </div>
          <div className="detail-form" ref={scrollRef} aria-busy={Boolean(busy)}>
            <fieldset className="settings-form-fields" disabled={Boolean(busy)}>
              <section className="form-section">
                <div className="form-section-head"><span><SlidersHorizontal size={15} />核心配置</span><small className="security-caption"><ShieldCheck size={13} />AES-256-GCM 本地加密</small></div>
                <div className="form-grid two">
                  <Field label="模型名称"><input className="input" value={draft.name} onChange={(event) => change({ name: event.target.value })} placeholder="例如：DeepSeek 官方直连" /></Field>
                  <Field label="供应商类别" hint={<span className="provider-category-tag">{categoryLabel}</span>}><span className="model-selector"><select className="input" value={categoryValue} onChange={(event) => changeCategory(event.target.value)}><optgroup label="官方直连"><option value="official:deepseek">DeepSeek Official（官方直连）</option><option value="official:openai">OpenAI Official（官方直连）</option><option value="official:anthropic">Anthropic Official（官方直连）</option><option value="official:google">Google Gemini（官方直连）</option></optgroup><optgroup label="兼容服务"><option value="compatible_gateway">兼容网关（OneAPI / NewAPI）</option><option value="custom_proxy">自建反代 / 中继通道（Proxy）</option><option value="local_ollama">本地 Ollama / vLLM 实例</option></optgroup></select><ChevronDown size={13} /></span></Field>
                </div>
                <Field label="API 地址 (Base URL)"><input className="input mono" value={draft.baseURL} onChange={(event) => change({ baseURL: event.target.value })} placeholder="https://your-provider.example.com/v1" spellCheck={false} /></Field>
                <Field label="API Key 密钥" hint={hasSavedKey ? '已安全保存 · 留空保留现有密钥' : draft.provider === 'custom' ? '本地或免密服务可留空' : '密钥仅保存在本机'}><span className="input-with-action"><input className="input mono" type={showKey ? 'text' : 'password'} value={draft.apiKey} onChange={(event) => change({ apiKey: event.target.value })} placeholder={hasSavedKey ? '已保存，输入新值可替换' : '输入 API Key'} autoComplete="new-password" spellCheck={false} /><button type="button" className="input-action" aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></span></Field>
              </section>
              <section className="form-section">
                <div className="form-section-head"><span><Radio size={15} />模型列表</span><small className="model-sync-status">{draft.availableModels.length ? <><CloudDownload size={12} />{modelSource === 'fetched' ? '已从 API 获取' : modelSource === 'manual' ? '含手动添加' : '已配置'} {draft.availableModels.length} 个模型</> : '获取在线列表，或手动添加模型'}</small></div>
                <div className="model-actions"><button className="button soft small" onClick={() => void fetchModels()}>{busy === 'fetching' ? <LoaderCircle size={13} className="spinning" /> : <RefreshCw size={13} />}{busy === 'fetching' ? '正在获取…' : '获取模型 (Fetch Models)'}</button><button className="button outline small" aria-expanded={manualEntry} onClick={() => setManualEntry((value) => !value)}><Plus size={13} />添加模型</button><span className="model-sync-hint">同步端点支持的模型标识</span></div>
                {manualEntry && <div className="manual-model-entry"><input ref={manualRef} className="input mono" aria-label="手动添加模型 ID" placeholder="输入模型 ID，例如 deepseek-chat" value={manualModel} onChange={(event) => setManualModel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addManualModel(); } }} /><button className="button primary small" disabled={!manualModel.trim()} onClick={addManualModel}>添加</button><button className="icon-button" aria-label="取消添加模型 ID" onClick={() => setManualEntry(false)}><X size={14} /></button></div>}
                <div className="model-list-label"><span>当前选用模型 (Model ID)</span><span>点击卡片快速切换</span></div>
                {draft.availableModels.length > 0 ? <div className="model-cards" role="radiogroup" aria-label="可用模型">{draft.availableModels.map((id) => <button key={id} className={'model-card ' + (draft.modelId === id ? 'selected' : '')} role="radio" aria-checked={draft.modelId === id} onClick={() => change({ modelId: id })}><span className="model-card-title"><strong className="mono" title={id}>{id}</strong><span className={'state-dot ' + (draft.modelId === id ? 'on' : '')} /></span><span className="model-card-description">{modelDescription(id)}</span><span className="model-choice-badge">{draft.modelId === id ? <><Check size={10} />当前已选</> : '点击切换'}</span></button>)}</div> : <div className="model-empty-state"><Radio size={18} /><span>尚未配置模型。获取模型列表，或输入服务端提供的模型 ID。</span></div>}
                <Field label="模型选择器"><span className="model-selector"><select className="input mono" value={draft.modelId} disabled={!draft.availableModels.length} onChange={(event) => change({ modelId: event.target.value })}>{!draft.modelId && <option value="">请选择模型</option>}{draft.availableModels.map((id) => <option key={id} value={id}>{id}</option>)}</select><ChevronDown size={13} /></span></Field>
              </section>
              <section className="form-section">
                <div className="form-section-head"><span><BrainCircuit size={15} />推理智能度与上下文参数</span></div>
                <div className="inference-grid">
                  <div className="temperature-control"><div className="slider-head"><label htmlFor="settings-temperature">采样温度 (Temperature)</label><span className="mono">{draft.temperature.toFixed(1)}</span></div><input id="settings-temperature" type="range" min="0" max={draft.provider === 'anthropic' ? 1 : 1.5} step="0.1" value={draft.temperature} onChange={(event) => change({ temperature: Number(event.target.value) })} /><div className="slider-scale"><span>0.0 确定严谨</span><span>0.6 均衡</span><span>{draft.provider === 'anthropic' ? '1.0' : '1.5'} 创造发散</span></div></div>
                  <div className="context-control"><div className="slider-head"><span>上下文窗口 (Context Window)</span><small>按模型规格设置</small></div><div className="context-presets" role="group" aria-label="上下文窗口预设">{[32000, 64000, 128000].map((value) => <button key={value} className={'context-preset ' + (Number(draft.contextWindow) === value ? 'selected' : '')} aria-pressed={Number(draft.contextWindow) === value} onClick={() => change({ contextWindow: String(value) })}>{value / 1000}k</button>)}</div>{![32000, 64000, 128000].includes(Number(draft.contextWindow)) && <span className="settings-draft-note">当前自定义：{draft.contextWindow} tokens</span>}</div>
                </div>
                <div className="thinking-row"><div className="thinking-copy"><strong>深度思考模式 (Thinking)</strong><p>{supportsThinking ? '调用 DeepSeek thinking 参数；开启时服务端会忽略温度。' : '当前提供商使用模型自身的推理配置，此开关适用于 DeepSeek。'}</p></div><button className="thinking-toggle" role="switch" aria-label="深度思考模式" aria-checked={supportsThinking && draft.enableThinking} disabled={!supportsThinking} onClick={() => change({ enableThinking: !draft.enableThinking })}><span /></button></div>
              </section>
              <details className="settings-advanced"><summary className="advanced-summary"><ChevronDown size={14} /><span>高级配置</span><small>能力评分、成本与限额</small></summary><div className="advanced-content">
                <label className="switch-row settings-enable-row"><input type="checkbox" checked={draft.enabled} onChange={(event) => change({ enabled: event.target.checked, ...(!event.target.checked ? { primary: false } : {}) })} /><span className="switch" aria-hidden="true" /><span>启用此模型参与路由</span></label>
                <div className="form-grid three"><Field label="上下文长度（tokens）">{numberInput('contextWindow', { min: 1, step: 1 })}</Field><Field label="最大输出 Token">{numberInput('maxTokens', { min: 1, step: 1 })}</Field><Field label="路由优先级">{numberInput('priority', { step: 1 })}</Field></div>
                <Field label="综合智能度（0–100）">{numberInput('intelligenceScore', { min: 0, max: 100, step: 1 })}</Field>
                <div className="form-grid five">{capabilityLabels.map(({ key, label }) => <Field key={key} label={label}><input className="input mono" type="number" min="0" max="100" step="1" value={draft.capabilities[key]} onChange={(event) => change({ capabilities: { ...draft.capabilities, [key]: event.target.value } })} /></Field>)}</div>
                <div className="form-grid two"><Field label="输入价格 / 1K Token">{numberInput('inputPrice', { min: 0, step: 0.0001 })}</Field><Field label="输出价格 / 1K Token">{numberInput('outputPrice', { min: 0, step: 0.0001 })}</Field><Field label="每分钟请求数">{numberInput('requestsPerMinute', { min: 0, step: 1 })}</Field><Field label="每日 Token 限额">{numberInput('tokensPerDay', { min: 0, step: 1 })}</Field></div>
              </div></details>
            </fieldset>
          </div>
          {notice && <div className={'settings-notice ' + notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'success' ? <CircleCheck size={14} /> : <X size={14} />}<span>{notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={12} /></button></div>}
          <footer className="detail-foot"><span className="foot-note"><ShieldCheck size={14} /><span>{dirty ? '配置有未保存的修改' : '配置已关联至本地环境'}</span></span><div className="foot-actions">{selected && <button className="button danger" disabled={Boolean(busy)} title="删除此模型配置" onClick={() => void removeSelected()}><Trash2 size={13} />删除模型</button>}<button className="button soft" disabled={Boolean(busy) || !draft.modelId.trim()} onClick={() => void testConnection()}>{busy === 'testing' && <LoaderCircle size={13} className="spinning" />}{busy === 'testing' ? '测试中…' : '连通测试'}</button><button className="button outline" disabled={busy === 'saving'} onClick={onClose}>取消</button><button className="button primary" disabled={Boolean(busy) || !draft.name.trim() || !draft.modelId.trim()} onClick={() => void save()}>{busy === 'saving' && <LoaderCircle size={13} className="spinning" />}{busy === 'saving' ? '保存中…' : '保存配置'}</button></div></footer>
        </main>
      </div>}
    </section>
  </div>;
}
