import React, { useEffect, useMemo, useState } from 'react';
import { CircleCheck, Coins, Eye, EyeOff, LockKeyhole, Network, Plus, Save, Search, Server, ShieldCheck, SlidersHorizontal, X, Zap } from 'lucide-react';
import { ModelConfig } from '../types';
import { errorMessage } from '../format';

interface SettingsProps { models: ModelConfig[]; onClose: () => void; onModelsChanged: (models: ModelConfig[]) => void; }
type CapabilityName = 'code' | 'reasoning' | 'creative' | 'vision' | 'longcontext';
type TestState = { success: boolean; latency?: number; message: string };
const capabilityLabels: Array<{ key: CapabilityName; label: string }> = [
  { key: 'reasoning', label: '推理 / 智能度' }, { key: 'code', label: '代码能力' }, { key: 'creative', label: '创意能力' }, { key: 'vision', label: '视觉能力' }, { key: 'longcontext', label: '长上下文能力' },
];
const providerLabels: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', deepseek: 'DeepSeek', custom: '自定义兼容' };
const providerInitials: Record<string, string> = { openai: 'OA', anthropic: 'AN', google: 'GG', deepseek: 'DS' };
const initials = (model: { provider: string; name: string }) => providerInitials[model.provider] ?? (model.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'AI');
function capabilityValue(model: ModelConfig | null, key: CapabilityName): string { return String(model?.capabilities?.find((capability) => capability.type === key)?.score ?? (key === 'reasoning' ? 70 : 0)); }
function numberOr(value: string, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
const unwrap = (result: unknown) => ((result as { model?: ModelConfig }).model ?? result) as ModelConfig;

/** Declared at module level so inputs keep focus across renders. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="field"><span className="field-label"><span>{label}</span>{hint && <small>{hint}</small>}</span>{children}</label>;
}

export function Settings({ models, onClose, onModelsChanged }: SettingsProps) {
  const [selected, setSelected] = useState<ModelConfig | null>(models[0] || null);
  const [name, setName] = useState(selected?.name || ''), [provider, setProvider] = useState(selected?.provider || 'openai'), [baseURL, setBaseURL] = useState(selected?.baseURL || ''), [modelId, setModelId] = useState(selected?.modelId || '');
  const [contextWindow, setContextWindow] = useState(String(selected?.contextWindow || selected?.maxTokens || 8192)), [maxTokens, setMaxTokens] = useState(String(selected?.maxTokens || 4096)), [intelligenceScore, setIntelligenceScore] = useState(String(selected?.intelligenceScore ?? capabilityValue(selected, 'reasoning'))), [priority, setPriority] = useState(String(selected?.priority ?? 0));
  const [requestsPerMinute, setRequestsPerMinute] = useState(String(selected?.rateLimit?.requestsPerMinute ?? 60)), [tokensPerDay, setTokensPerDay] = useState(String(selected?.rateLimit?.tokensPerDay ?? 100000));
  const [inputPrice, setInputPrice] = useState(String(selected?.costPer1kTokens?.input ?? 0)), [outputPrice, setOutputPrice] = useState(String(selected?.costPer1kTokens?.output ?? 0));
  const [capabilities, setCapabilities] = useState<Record<CapabilityName, string>>({ code: capabilityValue(selected, 'code'), reasoning: capabilityValue(selected, 'reasoning'), creative: capabilityValue(selected, 'creative'), vision: capabilityValue(selected, 'vision'), longcontext: capabilityValue(selected, 'longcontext') });
  const [enabled, setEnabled] = useState(selected?.enabled ?? true), [apiKey, setApiKey] = useState(''), [showKey, setShowKey] = useState(false), [busy, setBusy] = useState(false), [formError, setFormError] = useState<string | null>(null);
  const [query, setQuery] = useState(''), [tests, setTests] = useState<Record<string, TestState>>({}), [routing, setRouting] = useState<{ backend: string; available: boolean }>();
  // Reset the form only when switching models, so toggling "enabled" does not discard unsaved edits.
  useEffect(() => { setName(selected?.name || ''); setProvider(selected?.provider || 'openai'); setBaseURL(selected?.baseURL || ''); setModelId(selected?.modelId || ''); setContextWindow(String(selected?.contextWindow || selected?.maxTokens || 8192)); setMaxTokens(String(selected?.maxTokens || 4096)); setIntelligenceScore(String(selected?.intelligenceScore ?? capabilityValue(selected, 'reasoning'))); setPriority(String(selected?.priority ?? 0)); setRequestsPerMinute(String(selected?.rateLimit?.requestsPerMinute ?? 60)); setTokensPerDay(String(selected?.rateLimit?.tokensPerDay ?? 100000)); setInputPrice(String(selected?.costPer1kTokens?.input ?? 0)); setOutputPrice(String(selected?.costPer1kTokens?.output ?? 0)); setCapabilities({ code: capabilityValue(selected, 'code'), reasoning: capabilityValue(selected, 'reasoning'), creative: capabilityValue(selected, 'creative'), vision: capabilityValue(selected, 'vision'), longcontext: capabilityValue(selected, 'longcontext') }); setEnabled(selected?.enabled ?? true); setApiKey(''); setShowKey(false); setFormError(null); }, [selected?.id]);
  useEffect(() => { void window.amd?.routingStatus().then(setRouting).catch(() => undefined); }, []);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [onClose]);
  const visibleModels = useMemo(() => { const needle = query.trim().toLowerCase(); return needle ? models.filter((model) => [model.name, model.modelId, model.baseURL, model.provider].some((value) => value?.toLowerCase().includes(needle))) : models; }, [models, query]);
  const setCapability = (key: CapabilityName, value: string) => setCapabilities((current) => ({ ...current, [key]: value }));
  const testConnection = async () => {
    if (!selected || !window.amd) return;
    const id = selected.id; setBusy(true);
    try { const result = await window.amd.testModel(id) as { success?: boolean; latency?: number; error?: string }; setTests((current) => ({ ...current, [id]: { success: Boolean(result.success), latency: result.latency, message: result.success ? `连接正常 · ${result.latency ?? 0}ms` : `连接失败 · ${result.error || '未知错误'}` } })); }
    catch (cause) { setTests((current) => ({ ...current, [id]: { success: false, message: errorMessage(cause) } })); }
    finally { setBusy(false); }
  };
  const toggleEnabled = async () => {
    if (!selected || !window.amd) return;
    setBusy(true); setFormError(null);
    try { const saved = unwrap(await window.amd.models.update(selected.id, { enabled: !selected.enabled })); onModelsChanged(models.map((item) => item.id === saved.id ? saved : item)); setSelected(saved); setEnabled(saved.enabled); }
    catch (cause) { setFormError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!name.trim() || !modelId.trim()) return;
    if (provider === 'custom' && !baseURL.trim()) { setFormError('自定义提供商必须填写 API 地址'); return; }
    const context = numberOr(contextWindow, 8192), output = numberOr(maxTokens, 4096), intelligence = numberOr(intelligenceScore, 70);
    if (context <= 0 || output <= 0 || output > context) { setFormError('上下文长度和最大输出必须为正数，最大输出不能超过上下文长度'); return; }
    if (intelligence < 0 || intelligence > 100) { setFormError('综合智能度必须在 0 到 100 之间'); return; }
    const normalizedCapabilities = capabilityLabels.map(({ key }) => ({ type: key, score: Math.min(100, Math.max(0, numberOr(capabilities[key], 0))) })).filter((capability) => capability.score > 0);
    const metadata = { name: name.trim(), provider, baseURL: baseURL.trim() || undefined, modelId: modelId.trim(), contextWindow: context, intelligenceScore: intelligence, maxTokens: output, priority: numberOr(priority, 0), enabled, capabilities: normalizedCapabilities, costPer1kTokens: { input: Math.max(0, numberOr(inputPrice, 0)), output: Math.max(0, numberOr(outputPrice, 0)) }, rateLimit: { requestsPerMinute: Math.max(0, numberOr(requestsPerMinute, 60)), tokensPerDay: Math.max(0, numberOr(tokensPerDay, 100000)) } };
    setBusy(true); setFormError(null);
    try {
      const api = window.amd;
      if (api && selected) { const saved = unwrap(await api.models.update(selected.id, { ...metadata, ...(apiKey ? { apiKey } : {}) })); onModelsChanged(models.map((item) => item.id === selected.id ? saved : item)); setSelected(saved); setApiKey(''); }
      else if (api) { const saved = unwrap(await api.models.register({ ...metadata, apiKey })); onModelsChanged([saved, ...models]); setSelected(saved); }
    } catch (cause) { setFormError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const test = selected ? tests[selected.id] : undefined;
  const status = !selected ? { tone: 'muted', text: '新模型 · 尚未保存' } : test ? { tone: test.success ? '' : 'danger', text: test.success ? `连接正常 · ${test.latency ?? 0}ms` : '连接失败' } : !selected.hasApiKey && selected.provider !== 'custom' ? { tone: 'warn', text: '未配置密钥' } : { tone: 'muted', text: '尚未测试连通性' };
  const numberInput = (value: string, onChange: (value: string) => void, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => <input className="input mono" type="number" value={value} onChange={(event) => onChange(event.target.value)} {...props} />;

  return <div className="modal-overlay settings-overlay"><section className="modal-window settings-window" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header className="settings-titlebar"><div className="titlebar-left"><SlidersHorizontal size={16} className="accent-icon" /><h2 id="settings-title">设置 · 模型与端点配置</h2></div><div className="titlebar-right"><span className="kbd-hint"><kbd>Esc</kbd>关闭</span><button className="icon-button" title="关闭" aria-label="关闭设置" onClick={onClose}><X size={16} /></button></div></header>
    <div className="settings-body">
      <aside className="endpoint-list">
        <div className="endpoint-list-head">
          <div className="endpoint-list-title"><strong>端点与路由</strong><span className="count-pill accent">{models.filter((model) => model.enabled).length} 个已启用</span><button className="button primary small" onClick={() => setSelected(null)}><Plus size={13} />添加模型</button></div>
          <label className="search-box"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型、URL 或提供商…" aria-label="搜索模型" /></label>
        </div>
        <div className="endpoint-items">
          {visibleModels.map((model) => { const result = tests[model.id]; return <button key={model.id} className={`endpoint-item ${selected?.id === model.id ? 'selected' : ''}`} onClick={() => setSelected(model)}>
            <span className={`avatar ${model.provider}`}>{initials(model)}</span>
            <span className="endpoint-copy">
              <span className="endpoint-name"><strong>{model.name}</strong>{result ? <span className={`latency mono ${result.success ? '' : 'bad'}`}>{result.success ? <><Zap size={10} />{result.latency ?? 0}ms</> : '失败'}</span> : <i className={`state-dot ${model.enabled ? 'on' : ''}`} />}</span>
              <span className="endpoint-url mono">{model.baseURL || `${providerLabels[model.provider] ?? model.provider} 默认地址`}</span>
              <span className="endpoint-tags">{model.enabled ? <span className="tag solid">使用中</span> : <span className="tag">未启用</span>}<span className="tag">{providerLabels[model.provider] ?? model.provider}</span>{!model.hasApiKey && model.provider !== 'custom' && <span className="tag warn">未配置密钥</span>}</span>
            </span>
          </button>; })}
          {!visibleModels.length && <div className="empty-models">{models.length ? '没有匹配的模型' : '还没有模型配置'}</div>}
        </div>
        <div className="endpoint-list-foot"><span><i className="live-dot" />{routing?.backend === 'local-model' && routing.available ? '本地路由模型运行中' : '启发式路由引擎运行中'}</span><span>{models.length} 个端点</span></div>
      </aside>
      <main className="endpoint-detail">
        <div className="detail-head">
          <span className="avatar solid">{selected ? initials(selected) : <Plus size={15} />}</span>
          <div className="detail-head-copy"><div className="detail-title"><h3>{selected?.name || '添加模型'}</h3><span className={`status-pill ${status.tone}`}><i className="live-dot" />{status.text}</span></div><p className="mono">{selected ? `ID: ${selected.modelId} · ${providerLabels[selected.provider] ?? selected.provider}` : '填写端点信息后保存'}</p></div>
          {selected && <button className={`button ${selected.enabled ? 'primary' : 'outline'}`} disabled={busy} onClick={() => void toggleEnabled()}>{selected.enabled ? <><CircleCheck size={14} />已启用 · 参与自动路由</> : '启用此模型'}</button>}
        </div>
        <div className="detail-form">
          <section className="form-section">
            <div className="form-section-head"><span><Server size={15} />基本信息与端点</span><small>自定义地址支持 OpenAI 兼容 API</small></div>
            <div className="form-grid two"><Field label="显示名称"><input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：我的私有模型" /></Field><Field label="供应商类别"><select className="input" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google</option><option value="deepseek">DeepSeek（OpenAI 兼容）</option><option value="custom">自定义（OpenAI 兼容）</option></select></Field></div>
            <Field label="API Base URL" hint="非官方服务填写基础地址，例如 https://example.com/v1"><input className="input mono" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder={provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : provider === 'google' ? 'https://generativelanguage.googleapis.com/v1beta/models/...' : 'https://your-provider.example.com/v1'} /></Field>
            <Field label="模型标识 (Model ID)"><input className="input mono" value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="例如：gpt-4o-mini 或 deepseek-chat" /></Field>
          </section>
          <section className="form-section">
            <div className="form-section-head"><span><ShieldCheck size={15} />凭据与安全</span><span className={`status-pill ${selected?.hasApiKey ? '' : 'muted'}`}>{selected?.hasApiKey ? '已保存密钥' : '尚未保存密钥'}</span></div>
            <Field label="API Key 密钥" hint={selected ? '留空以保留现有密钥' : undefined}><span className="input-with-action"><input className="input mono" type={showKey ? 'text' : 'password'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selected?.hasApiKey ? '已保存，输入新值可替换' : 'sk-...'} autoComplete="off" spellCheck={false} /><button type="button" className="input-action" title={showKey ? '隐藏' : '显示'} aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></span></Field>
            <p className="security-note"><LockKeyhole size={13} />密钥以 AES-256-GCM 加密后保存在本机，加密密钥由系统安全存储保护（macOS 上为钥匙串）。已保存的密钥不会回传到界面。</p>
          </section>
          <section className="form-section">
            <div className="form-section-head"><span><SlidersHorizontal size={15} />路由与推理参数</span><small>自动路由按这些参数选择模型</small></div>
            <div className="slider-block"><div className="slider-head"><span>综合智能度</span><span className="value-chip mono">{intelligenceScore}</span></div><input type="range" min="0" max="100" step="1" value={intelligenceScore} onChange={(event) => setIntelligenceScore(event.target.value)} aria-label="综合智能度" /><div className="slider-scale mono"><span>0 基础</span><span>50 均衡</span><span>100 旗舰</span></div></div>
            <div className="form-grid three"><Field label="上下文长度（tokens）">{numberInput(contextWindow, setContextWindow, { min: 1, step: 1 })}</Field><Field label="最大输出（tokens）">{numberInput(maxTokens, setMaxTokens, { min: 1, step: 1 })}</Field><Field label="优先级">{numberInput(priority, setPriority, { step: 1 })}</Field></div>
            {!selected && <label className="switch-row"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span className="switch" aria-hidden="true" /><span>保存后启用自动路由</span></label>}
            <div className="form-subhead">模型能力评分（0–100）</div>
            <div className="form-grid five">{capabilityLabels.map(({ key, label }) => <Field key={key} label={label}>{numberInput(capabilities[key], (value) => setCapability(key, value), { min: 0, max: 100, step: 1 })}</Field>)}</div>
          </section>
          <section className="form-section">
            <div className="form-section-head"><span><Coins size={15} />成本与限额</span><small>用于成本统计与路由估算</small></div>
            <div className="form-grid four"><Field label="输入价格 / 1K">{numberInput(inputPrice, setInputPrice, { min: 0, step: 0.0001 })}</Field><Field label="输出价格 / 1K">{numberInput(outputPrice, setOutputPrice, { min: 0, step: 0.0001 })}</Field><Field label="每分钟请求数">{numberInput(requestsPerMinute, setRequestsPerMinute, { min: 0, step: 1 })}</Field><Field label="每日 Token 限额">{numberInput(tokensPerDay, setTokensPerDay, { min: 0, step: 1 })}</Field></div>
          </section>
          {formError && <div className="error-banner" role="alert">{formError}</div>}
          {test && !test.success && <div className="error-banner">{test.message}</div>}
        </div>
        <footer className="detail-foot">
          <span className="foot-note"><ShieldCheck size={14} />{selected ? '连通测试使用已保存的配置' : '配置仅保存在本机'}</span>
          <div className="foot-actions">{selected && <button className="button soft" disabled={busy} onClick={() => void testConnection()}><Network size={14} />连通测试</button>}<button className="button outline" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !name.trim() || !modelId.trim()} onClick={() => void save()}><Save size={14} />{busy ? '处理中…' : '保存配置'}</button></div>
        </footer>
      </main>
    </div>
  </section></div>;
}
