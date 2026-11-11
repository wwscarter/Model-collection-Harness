import { supportsOperation } from '@core/models/ModelOperations';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, LoaderCircle, RefreshCw } from 'lucide-react';
import type { RoutingSettings } from '@core/routing/RoutingSettings';
import type { RoutingClassifierStatus } from '@core/routing/LocalRoutingModel';
import type { ModelConfig } from '../types';
import { errorMessage } from '../format';

export function routingStatusLabel(status?: RoutingClassifierStatus): string {
  if (!status) return '正在读取路由状态…';
  if (status.backend === 'heuristic') return '关键词规则就绪';
  if (status.warmingUp) return '正在预热本地模型，暂用规则';
  if (status.reachable === false) return '无法连接本机 Ollama，使用规则回退';
  if (status.modelInstalled === false) return '本机尚未安装所选模型，使用规则回退';
  if (status.lastError) return '最近检测或分类失败，可使用规则回退';
  if (!status.available) return '本地分类模型尚未验证';
  return status.loaded ? '本地分类模型已加载' : '本地分类模型可用，尚未加载';
}

const cloneSettings = (settings: RoutingSettings): RoutingSettings => ({
  ...settings, classifier: { ...settings.classifier }, planning: { ...settings.planning },
  budget: { maxCostUsd: settings.budget?.maxCostUsd ?? 0.25, maxDurationMs: settings.budget?.maxDurationMs ?? 600_000 },
});
const fingerprint = (settings: RoutingSettings) => JSON.stringify(settings);

interface ModelRoutingSettingsProps { onRoutingStatusChange?: (status: RoutingClassifierStatus) => void; }

export function ModelRoutingSettings({ onRoutingStatusChange }: ModelRoutingSettingsProps) {
  const [draft, setDraft] = useState<RoutingSettings>();
  const [saved, setSaved] = useState<RoutingSettings>();
  const [savedStatus, setSavedStatus] = useState<RoutingClassifierStatus>();
  const [probeResult, setProbeResult] = useState<{ fingerprint: string; baseURL: string; status: RoutingClassifierStatus; models: string[] }>();
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'saving' | 'probing' | 'refreshing' | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [notice, setNotice] = useState<{ error: boolean; text: string }>();
  const mounted = useRef(false);
  const loadRevision = useRef(0);

  const load = useCallback(async () => {
    const revision = ++loadRevision.current;
    setLoading(true); setLoadError(undefined); setNotice(undefined);
    try {
      const api = window.amd;
      if (!api?.routingConfig) throw new Error('路由设置接口尚未连接，请在桌面应用中使用。');
      const [configuration, modelList] = await Promise.allSettled([api.routingConfig.get(), api.models.list()]);
      if (!mounted.current || revision !== loadRevision.current) return;
      if (configuration.status === 'rejected') throw configuration.reason;
      setDraft(cloneSettings(configuration.value.settings));
      setSaved(cloneSettings(configuration.value.settings));
      setSavedStatus(configuration.value.status);
      setProbeResult(undefined);
      if (modelList.status === 'fulfilled') setModels(modelList.value);
      else setNotice({ error: true, text: '执行模型列表读取失败，已保留原有分工配置。' });
    } catch (cause) {
      if (mounted.current && revision === loadRevision.current) setLoadError(errorMessage(cause));
    } finally {
      if (mounted.current && revision === loadRevision.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; loadRevision.current += 1; };
  }, [load]);

  const update = (change: (current: RoutingSettings) => RoutingSettings) => {
    setDraft((current) => current ? change(current) : current);
    setNotice(undefined);
  };
  const normalized = (): RoutingSettings => {
    if (!draft) throw new Error('请先读取路由设置。');
    return {
      ...draft,
      classifier: { ...draft.classifier, baseURL: draft.classifier.baseURL.trim(), model: draft.classifier.model.trim() },
      planning: { ...draft.planning, modelId: draft.planning.modelId || undefined },
      utilityModelId: draft.utilityModelId || undefined,
    };
  };
  const probe = async () => {
    setBusy('probing'); setNotice(undefined);
    try {
      if (!window.amd?.routingConfig) throw new Error('路由设置接口尚未连接');
      const settings = normalized();
      const result = await window.amd.routingConfig.probe(settings);
      if (!mounted.current) return;
      setProbeResult({ ...result, baseURL: settings.classifier.baseURL, fingerprint: fingerprint(draft!) });
      setNotice({ error: !result.status.available, text: result.status.available ? '本机服务与所选模型已验证，草稿尚未保存。' : '检测完成，草稿尚未保存。请查看下方状态。' });
    } catch (cause) {
      if (mounted.current) setNotice({ error: true, text: '检测失败：' + errorMessage(cause) });
    } finally { if (mounted.current) setBusy(null); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy('saving'); setNotice(undefined);
    try {
      if (!window.amd?.routingConfig) throw new Error('路由设置接口尚未连接');
      const result = await window.amd.routingConfig.set(normalized());
      if (!mounted.current) return;
      setSaved(cloneSettings(result.settings)); setDraft(cloneSettings(result.settings));
      setSavedStatus(result.status); setProbeResult(undefined);
      onRoutingStatusChange?.(result.status);
      setNotice({ error: false, text: '路由与模型分工已保存，从下一轮任务生效。' });
    } catch (cause) {
      if (mounted.current) setNotice({ error: true, text: '保存失败，已保留草稿：' + errorMessage(cause) });
    } finally { if (mounted.current) setBusy(null); }
  };
  const refreshStatus = async () => {
    setBusy('refreshing'); setNotice(undefined);
    try {
      if (!window.amd) throw new Error('路由状态接口尚未连接');
      const status = await window.amd.routingStatus();
      if (mounted.current) { setSavedStatus(status); onRoutingStatusChange?.(status); }
    } catch (cause) {
      if (mounted.current) setNotice({ error: true, text: '状态读取失败：' + errorMessage(cause) });
    } finally { if (mounted.current) setBusy(null); }
  };

  const dirty = Boolean(draft && saved && fingerprint(draft) !== fingerprint(saved));
  const currentProbe = draft && probeResult?.fingerprint === fingerprint(draft) ? probeResult : undefined;
  const installedModels = draft && probeResult?.baseURL === draft.classifier.baseURL.trim() ? probeResult.models : [];
  const status = currentProbe?.status ?? savedStatus;
  const enabledModels = models.filter((model) => model.enabled && supportsOperation(model, 'text.chat') && !model.credentialError && (model.provider === 'custom' || model.hasApiKey));
  const modelOptions = (selected?: string, automatic = '自动按能力选择') => <>
    <option value="">{automatic}</option>
    {selected && !enabledModels.some((model) => model.id === selected) && <option value={selected}>已保存的模型（当前不可用）</option>}
    {enabledModels.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.modelId}</option>)}
  </>;

  return <section className="runtime-card model-routing-settings" aria-labelledby="model-routing-title">
    <div className="runtime-card-heading"><span className="runtime-card-icon"><GitBranch size={16} /></span><div><h3 id="model-routing-title">任务路由与模型分工</h3><p>本地模型识别任务，应用安排派发和汇总；DeepSeek 与其他模型同等参与。</p></div></div>
    {loading ? <p className="runtime-hint" role="status">正在读取路由设置…</p> : loadError ? <div className="routing-config-load-error" role="alert"><p>无法读取路由设置：{loadError}</p><button type="button" className="button outline small" onClick={() => void load()}><RefreshCw size={12} />重新读取</button></div> : draft && <form onSubmit={(event) => void save(event)}>
      <fieldset className="routing-config-fields" disabled={Boolean(busy)}>
        <div className="form-grid two">
          <label className="field"><span className="field-label">任务分类方式</span><select className="input" aria-label="任务分类方式" value={draft.classifier.mode} onChange={(event) => update((value) => ({ ...value, classifier: { ...value.classifier, mode: event.target.value as 'rules' | 'ollama' } }))}><option value="rules">关键词规则</option><option value="ollama">本机 Ollama</option></select></label>
          <label className="field"><span className="field-label">任务规划</span><select className="input" aria-label="任务规划" value={draft.planning.mode} onChange={(event) => update((value) => ({ ...value, planning: { ...value.planning, mode: event.target.value as 'auto' | 'off' } }))}><option value="auto">按任务需要规划</option><option value="off">关闭额外规划</option></select></label>
        </div>
        {draft.classifier.mode === 'ollama' && <div className="routing-local-fields">
          <label className="field"><span className="field-label">本机 Ollama 地址</span><input className="input mono" aria-label="本机 Ollama 地址" type="url" required value={draft.classifier.baseURL} onChange={(event) => update((value) => ({ ...value, classifier: { ...value.classifier, baseURL: event.target.value } }))} placeholder="http://127.0.0.1:11434" spellCheck={false} /></label>
          <div className="form-grid two">
            <label className="field"><span className="field-label">分类模型 ID</span><input className="input mono" aria-label="分类模型 ID" required list="routing-installed-models" value={draft.classifier.model} onChange={(event) => update((value) => ({ ...value, classifier: { ...value.classifier, model: event.target.value } }))} spellCheck={false} /><datalist id="routing-installed-models">{installedModels.map((model) => <option key={model} value={model} />)}</datalist></label>
            <label className="field"><span className="field-label">分类等待上限（毫秒）</span><input className="input mono" aria-label="分类等待上限（毫秒）" type="number" required min={250} max={30000} step={250} value={draft.classifier.timeoutMs} onChange={(event) => update((value) => ({ ...value, classifier: { ...value.classifier, timeoutMs: Number(event.target.value) } }))} /></label>
          </div>
          <div className="routing-probe-row"><button type="button" className="button outline small" onClick={() => void probe()}>{busy === 'probing' ? <LoaderCircle size={12} className="spinning" /> : <RefreshCw size={12} />}{busy === 'probing' ? '正在检测…' : '检测服务与模型'}</button><small>读取已安装模型，不会自动下载。</small></div>
          <p className="runtime-hint">当前仅连接本机服务。分类失败或超时会使用关键词规则，分类模型不会自动加入回答模型列表。</p>
        </div>}
        <div className="form-grid two routing-role-fields">
          <label className="field"><span className="field-label">规划模型</span><select className="input" aria-label="规划模型" value={draft.planning.modelId ?? ''} disabled={draft.planning.mode === 'off'} onChange={(event) => update((value) => ({ ...value, planning: { ...value.planning, modelId: event.target.value || undefined } }))}>{modelOptions(draft.planning.modelId)}</select></label>
          <label className="field"><span className="field-label">摘要与归档辅助模型</span><select className="input" aria-label="摘要与归档辅助模型" value={draft.utilityModelId ?? ''} onChange={(event) => update((value) => ({ ...value, utilityModelId: event.target.value || undefined }))}>{modelOptions(draft.utilityModelId, '自动选择辅助模型')}</select></label>
        </div>
        <p className="runtime-hint">执行模型仍遵循会话选择和路由规则；规划模型提供分工建议，不会强制接管最终回答。</p>
        <label className="field"><span className="field-label">计划执行方式</span><select className="input" aria-label="计划执行方式" value={draft.planning.executionMode ?? 'auto'} onChange={(event) => update((value) => ({ ...value, planning: { ...value.planning, executionMode: event.target.value as 'auto' | 'confirm' | 'only' } }))}><option value="auto">自动执行</option><option value="confirm">确认后执行</option><option value="only">仅规划</option></select></label>
        <label className="field"><span className="field-label">辅助模型调用通道</span><select className="input" aria-label="辅助模型调用通道" value={draft.legacyProviders ? 'legacy' : 'pi'} onChange={(event) => update((value) => ({ ...value, legacyProviders: event.target.value === 'legacy' }))}><option value="pi">统一 Pi 适配器</option><option value="legacy">旧版适配器（兼容回退）</option></select></label>
        <p className="runtime-hint">规划、摘要、复核、记忆提取和连接测试默认使用与执行模型相同的协议实现；端点兼容异常时可切回旧版。</p>
        <div className="form-grid two routing-budget-fields">
          <label className="field"><span className="field-label">每轮预估费用上限（USD）</span><input className="input mono" aria-label="每轮预估费用上限（USD）" type="number" required min={0.01} max={1000} step={0.01} value={draft.budget?.maxCostUsd ?? 0.25} onChange={(event) => update((value) => ({ ...value, budget: { maxDurationMs: value.budget?.maxDurationMs ?? 600_000, maxCostUsd: Number(event.target.value) } }))} /></label>
        </div>
        <p className="runtime-hint">按模型配置单价累计估算规划、模型调用、执行和归档等文本调用费用，与供应商账单可能不同；生图不参与此预算。任务默认没有时间上限。保存后从下一轮生效。</p>
        <div className="routing-config-footer"><button type="submit" className="button primary small" disabled={!dirty}>{busy === 'saving' ? '正在保存…' : '保存路由设置'}</button><span>{dirty ? '有未保存的修改' : '当前配置已保存'}</span></div>
      </fieldset>
      {status && <div className="routing-config-status" aria-label="分类服务状态"><div className="routing-status-heading"><strong>{currentProbe ? '草稿检测' : '已保存配置'} · {routingStatusLabel(status)}</strong>{!currentProbe && <button type="button" className="icon-button" aria-label="刷新分类服务状态" disabled={Boolean(busy)} onClick={() => void refreshStatus()}><RefreshCw size={12} className={busy === 'refreshing' ? 'spinning' : ''} /></button>}</div>{status.lastError && <span>{status.lastError}</span>}{status.lastLatencyMs !== undefined && <small>最近耗时 {Math.round(status.lastLatencyMs)} ms</small>}</div>}
      {notice && <div className={'runtime-notice ' + (notice.error ? 'is-error' : '')} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}
    </form>}
  </section>;
}
