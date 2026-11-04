import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Waypoints } from 'lucide-react';
import type { ModelConfig } from '../types';

interface RoutingPanelProps { onClose: () => void; }

type RuleDraft = {
  key: string;
  id: string;
  enabled: boolean;
  priority: number;
  taskTypes: string[];
  complexity: string[];
  promptKeywords: string;
  primaryModelId: string;
  strategy: string;
  collaboratorModelIds: string[];
  fallbackModelIds: string[];
};

type PolicyDraft = {
  defaultsStrategy: string;
  rules: RuleDraft[];
};

const TASK_TYPES = ['code', 'reasoning', 'analysis', 'review', 'creative', 'general'];
const COMPLEXITIES = ['low', 'medium', 'high'];
const STRATEGIES = ['single', 'plan', 'parallel', 'plan+verify', 'escalate'];

function emptyRule(rules: RuleDraft[]): RuleDraft {
  let index = rules.length + 1;
  while (rules.some((rule) => rule.id === 'rule-' + index)) index += 1;
  return {
    key: crypto.randomUUID(), id: 'rule-' + index, enabled: true, priority: 0, taskTypes: [], complexity: [],
    promptKeywords: '', primaryModelId: '', strategy: 'single', collaboratorModelIds: [], fallbackModelIds: [],
  };
}

function parsePolicy(text: string): PolicyDraft {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults as Record<string, unknown> : {};
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  return {
    defaultsStrategy: typeof defaults.strategy === 'string' ? defaults.strategy : 'single',
    rules: rules.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object')).map((rule, index) => {
      const when = rule.when && typeof rule.when === 'object' ? rule.when as Record<string, unknown> : {};
      const then = rule.then && typeof rule.then === 'object' ? rule.then as Record<string, unknown> : {};
      const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      return {
        key: crypto.randomUUID(),
        id: typeof rule.id === 'string' ? rule.id : 'rule-' + (index + 1),
        enabled: rule.enabled !== false,
        priority: typeof rule.priority === 'number' ? rule.priority : 0,
        taskTypes: strings(when.taskTypes),
        complexity: strings(when.complexity),
        promptKeywords: strings(when.promptKeywords).join(', '),
        primaryModelId: typeof then.primaryModelId === 'string' ? then.primaryModelId : '',
        strategy: typeof then.strategy === 'string' ? then.strategy : 'single',
        collaboratorModelIds: strings(then.collaboratorModelIds),
        fallbackModelIds: strings(then.fallbackModelIds),
      };
    }),
  };
}

function serializePolicy(draft: PolicyDraft): string {
  const ids = draft.rules.map((rule) => rule.id.trim());
  if (ids.some((id) => !id)) throw new Error('请填写每条规则的 ID');
  if (new Set(ids).size !== ids.length) throw new Error('规则 ID 不能重复');
  const rules = draft.rules.map((rule) => ({
    id: rule.id.trim(),
    enabled: rule.enabled,
    priority: rule.priority,
    when: {
      ...(rule.taskTypes.length ? { taskTypes: rule.taskTypes } : {}),
      ...(rule.complexity.length ? { complexity: rule.complexity } : {}),
      ...(rule.promptKeywords.trim() ? { promptKeywords: rule.promptKeywords.split(',').map((word) => word.trim()).filter(Boolean) } : {}),
    },
    then: {
      ...(rule.primaryModelId ? { primaryModelId: rule.primaryModelId } : {}),
      strategy: rule.strategy,
      ...(rule.collaboratorModelIds.length ? { collaboratorModelIds: rule.collaboratorModelIds } : {}),
      ...(rule.fallbackModelIds.length ? { fallbackModelIds: rule.fallbackModelIds } : {}),
    },
  }));
  return JSON.stringify({ version: 1, defaults: { strategy: draft.defaultsStrategy }, rules }, null, 2) + '\n';
}

export function RoutingPanel({ onClose }: RoutingPanelProps) {
  const [path, setPath] = useState('');
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<PolicyDraft>({ defaultsStrategy: 'single', rules: [] });
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadRetry, setLoadRetry] = useState(0);
  const [history, setHistory] = useState<Array<{ name: string; savedAt: string }>>([]);
  const [historyName, setHistoryName] = useState('');

  const loadHistory = async () => {
    try { const list = await window.amd?.routingRules?.history() ?? []; setHistory(list); }
    catch { setHistory([]); }
  };
  const applyText = (value: string) => {
    setText(value);
    try { setDraft(parsePolicy(value)); setError(null); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
  };
  useEffect(() => {
    let active = true;
    setLoading(true); setHasLoaded(false); setError(null);
    void (async () => {
      try {
        if (!window.amd?.routingRules) throw new Error('路由规则接口尚未连接');
        const value = await window.amd.routingRules.get();
        if (active) {
          setPath(value.path); setHasLoaded(true);
          if (!applyText(value.text)) setMode('json');
        }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (active) setLoading(false); }
    })();
    void window.amd?.listModels().then((list) => { if (active) setModels(Array.isArray(list) ? list : []); }).catch(() => undefined);
    void loadHistory();
    return () => { active = false; };
  }, [loadRetry]);

  const restore = async () => {
    if (!historyName) return;
    setBusy(true); setError(null);
    try {
      if (!window.amd?.routingRules) throw new Error('路由规则接口尚未连接');
      const result = await window.amd.routingRules.restore(historyName);
      applyText(result.text); setDiagnostics(result.diagnostics); setSaved(true);
      await loadHistory();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const format = () => {
    try {
      const source = mode === 'form' ? serializePolicy(draft) : text;
      applyText(JSON.stringify(JSON.parse(source), null, 2) + '\n');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const switchMode = (next: 'form' | 'json') => {
    if (next === mode) return;
    try {
      if (next === 'json') { setText(serializePolicy(draft)); setMode('json'); setError(null); return; }
      setDraft(parsePolicy(text)); setMode('form'); setError(null);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const updateRule = (index: number, patch: Partial<RuleDraft>) => {
    setDraft((current) => ({ ...current, rules: current.rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule) }));
    setSaved(false);
  };
  const save = async () => {
    if (!hasLoaded || loading || busy) return;
    setBusy(true); setError(null); setSaved(false); setDiagnostics([]);
    try {
      const payload = mode === 'form' ? serializePolicy(draft) : text;
      JSON.parse(payload);
      if (!window.amd?.routingRules) throw new Error('路由规则接口尚未连接');
      const result = await window.amd.routingRules.set(payload);
      setText(payload);
      setDiagnostics(result?.diagnostics ?? []);
      setSaved(true);
      await loadHistory();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const modelOptions = models.filter((model) => model.enabled).map((model) => ({ id: model.id, label: model.name + ' · ' + model.id }));
  const selectMulti = (value: string[], onChange: (value: string[]) => void, label: string) => <select multiple className="routing-multi" value={value} aria-label={label} onChange={(event) => onChange(Array.from(event.target.selectedOptions).map((option) => option.value))}>{modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>;

  return <div className="modal-overlay routing-overlay"><section className="modal-window routing-window" role="dialog" aria-modal="true" aria-labelledby="routing-title">
    <header className="routing-header"><div><h2 id="routing-title"><Waypoints size={17} />路由规则</h2><p>规则在每次新任务开始时生效；只从已启用、有凭据、未超配额的模型中选择。</p></div><div className="routing-mode"><button disabled={busy || loading || !hasLoaded} className={mode === 'form' ? 'active' : ''} onClick={() => switchMode('form')}>表单</button><button disabled={busy || loading || !hasLoaded} className={mode === 'json' ? 'active' : ''} onClick={() => switchMode('json')}>JSON</button><button className="close-button" disabled={busy} onClick={onClose} aria-label="关闭路由规则">×</button></div></header>
    <div className="routing-path mono">{path || '正在读取…'}</div>
    <fieldset className="routing-fields" disabled={busy || loading || !hasLoaded}>
    <div className="routing-content" aria-busy={busy || loading}>
      {mode === 'json' ? <textarea className="routing-editor mono" value={text} onChange={(event) => { setText(event.target.value); setSaved(false); }} spellCheck={false} aria-label="路由规则 JSON" /> : <div className="routing-form">
        <label className="routing-default">默认策略<select value={draft.defaultsStrategy} onChange={(event) => { setDraft((current) => ({ ...current, defaultsStrategy: event.target.value })); setSaved(false); }}>{STRATEGIES.map((strategy) => <option key={strategy} value={strategy}>{strategy}</option>)}</select></label>
        {draft.rules.map((rule, index) => <article className={'routing-rule ' + (rule.enabled ? '' : 'disabled')} key={rule.key}>
          <div className="routing-rule-head"><label><input type="checkbox" checked={rule.enabled} onChange={(event) => updateRule(index, { enabled: event.target.checked })} />启用</label><input className="rule-id" value={rule.id} onChange={(event) => updateRule(index, { id: event.target.value })} aria-label="规则 ID" /><label className="rule-priority">优先级<input type="number" value={rule.priority} onChange={(event) => updateRule(index, { priority: Number(event.target.value) })} /></label><button className="routing-remove" aria-label="删除规则" onClick={() => { setDraft((current) => ({ ...current, rules: current.rules.filter((_item, ruleIndex) => ruleIndex !== index) })); setSaved(false); }}><Trash2 size={13} /></button></div>
          <div className="routing-rule-grid">
            <fieldset><legend>任务类型</legend>{TASK_TYPES.map((type) => <label key={type}><input type="checkbox" checked={rule.taskTypes.includes(type)} onChange={(event) => updateRule(index, { taskTypes: event.target.checked ? [...rule.taskTypes, type] : rule.taskTypes.filter((item) => item !== type) })} />{type}</label>)}</fieldset>
            <fieldset><legend>复杂度</legend>{COMPLEXITIES.map((level) => <label key={level}><input type="checkbox" checked={rule.complexity.includes(level)} onChange={(event) => updateRule(index, { complexity: event.target.checked ? [...rule.complexity, level] : rule.complexity.filter((item) => item !== level) })} />{level}</label>)}</fieldset>
            <label className="routing-field">关键词<input value={rule.promptKeywords} onChange={(event) => updateRule(index, { promptKeywords: event.target.value })} placeholder="用逗号分隔，例如 重构, 安全" /></label>
          </div>
          <div className="routing-rule-grid then-grid">
            <label className="routing-field">主模型<select value={rule.primaryModelId} onChange={(event) => updateRule(index, { primaryModelId: event.target.value })}><option value="">自动路由</option>{modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
            <label className="routing-field">策略<select value={rule.strategy} onChange={(event) => updateRule(index, { strategy: event.target.value })}>{STRATEGIES.map((strategy) => <option key={strategy} value={strategy}>{strategy}</option>)}</select></label>
            <label className="routing-field">fallback（多选）{selectMulti(rule.fallbackModelIds, (value) => updateRule(index, { fallbackModelIds: value }), 'fallback 模型')}</label>
            <label className="routing-field">协作者（多选）{selectMulti(rule.collaboratorModelIds, (value) => updateRule(index, { collaboratorModelIds: value }), '协作模型')}</label>
          </div>
        </article>)}
        <button className="button outline routing-add" onClick={() => { setDraft((current) => ({ ...current, rules: [...current.rules, emptyRule(current.rules)] })); setSaved(false); }}><Plus size={13} />添加规则</button>
      </div>}
    </div>
    {!!diagnostics.length && <div className="routing-diagnostics"><strong>已保存，但有规则被忽略：</strong>{diagnostics.map((message, index) => <div key={index}>{message}</div>)}</div>}
    {saved && !diagnostics.length && <div className="routing-saved">规则已保存，将从下一个任务开始生效。</div>}
    <div className="routing-history"><div><strong>历史版本</strong><span>每次保存前自动归档，最多保留 20 份。</span></div><select value={historyName} onChange={(event) => setHistoryName(event.target.value)} aria-label="路由规则历史版本"><option value="">选择历史版本…</option>{history.map((item) => <option key={item.name} value={item.name}>{new Date(item.savedAt).toLocaleString('zh-CN')}</option>)}</select><button className="button outline" disabled={!historyName || busy} onClick={() => void restore()}>恢复</button><button className="button outline" onClick={format}>格式化</button></div>
    </fieldset>
    {error && <div className="memory-error" role="alert">{error}</div>}
    {!hasLoaded && !loading && <button className="button outline" onClick={() => setLoadRetry((value) => value + 1)}>重新读取</button>}
    <footer className="routing-footer"><span>支持任务类型/复杂度/关键词匹配；保存前会校验并归档。</span><div><button className="button outline" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || loading || !hasLoaded} onClick={() => void save()}>{busy ? '校验中…' : '保存并生效'}</button></div></footer>
  </section></div>;
}
