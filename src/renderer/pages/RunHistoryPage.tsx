import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Tooltip } from 'antd';
import { Activity, ArrowLeft, ChevronRight, PanelLeft, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import type { RunTrace, TraceRun } from '../types';
import { TraceTimeline, traceModelSnapshot } from '../components/TraceTimeline';
import { RoutingClassificationFeedback } from '../components/RoutingClassificationFeedback';
import { traceDuration, traceModelCallSpans, traceRunUsage } from '../tracePresentation';
import '../styles/monitoring.css';

interface RunHistoryPageProps { liveTrace?: RunTrace; onBack?: () => void; }
type Range = 'all' | '24h' | '7d' | '30d';
const statusLabels = { success: '成功', failed: '失败', cancelled: '已取消', running: '进行中' };
const taskLabels: Record<string, string> = { code: '代码实施', reasoning: '推理与规划', analysis: '分析与比较', review: '代码审查', creative: '创意写作', general: '日常交流' };
const duration = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(1) + ' s';
const integer = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString('en-US');
const time = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '时间未记录';
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function RunHistoryPage({ liveTrace, onBack }: RunHistoryPageProps) {
  const [listOpen, setListOpen] = useState(() => window.innerWidth > 1350);
  const compact = useRef(window.innerWidth <= 1350);
  useEffect(() => {
    const resize = () => {
      const next = window.innerWidth <= 1350;
      if (next !== compact.current) setListOpen(!next);
      compact.current = next;
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const [range, setRange] = useState<Range>('all');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [runs, setRuns] = useState<TraceRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(liveTrace?.run.id);
  const [trace, setTrace] = useState<RunTrace>();
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [traceError, setTraceError] = useState<string>();
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceReload, setTraceReload] = useState(0);
  const loadRequest = useRef(0);
  const load = useCallback(async () => {
    const revision = ++loadRequest.current;
    setLoading(true); setError(undefined);
    try {
      if (!window.amd?.trace?.list) throw new Error('运行记录接口尚未连接');
      const recent = await window.amd.trace.list(50);
      if (revision !== loadRequest.current) return;
      setRuns(recent); setLoaded(true);
    } catch (cause) { if (revision === loadRequest.current) setError(message(cause)); }
    finally { if (revision === loadRequest.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    return () => { loadRequest.current += 1; };
  }, [load, liveTrace?.run.id, liveTrace?.run.status]);

  const recentRuns = useMemo(() => {
    const merged = new Map(runs.map((run) => [run.id, run]));
    if (liveTrace) merged.set(liveTrace.run.id, liveTrace.run);
    return [...merged.values()].sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0)).slice(0, 50);
  }, [runs, liveTrace?.run]);
  const visibleRuns = useMemo(() => {
    const now = Date.now();
    const from = range === 'all' ? -Infinity : now - ({ '24h': 1, '7d': 7, '30d': 30 }[range] * 86_400_000);
    const needle = query.trim().toLowerCase();
    return recentRuns.filter((run) => {
      const start = Date.parse(run.startedAt);
      return (range === 'all' || Number.isFinite(start) && start >= from && start <= now)
        && (status === 'all' || run.status === status)
        && (!needle || [run.id, run.sessionId, run.taskType, taskLabels[run.taskType ?? 'general']].some((value) => value?.toLowerCase().includes(needle)));
    });
  }, [recentRuns, range, status, query]);
  const selectedRun = visibleRuns.find((run) => run.id === selectedId) ?? visibleRuns[0];
  const effectiveId = selectedRun?.id;
  const selectedLiveTrace = liveTrace?.run.id === effectiveId ? liveTrace : undefined;
  useEffect(() => {
    setTraceError(undefined); setTrace(undefined);
    if (!effectiveId || selectedLiveTrace) { setTraceLoading(false); return; }
    let active = true;
    setTraceLoading(true);
    void (async () => {
      try {
        if (!window.amd?.trace?.get) throw new Error('调用链接口尚未连接');
        const value = await window.amd.trace.get(effectiveId);
        if (!active) return;
        if (!value || value.run.id !== effectiveId) throw new Error('此运行的调用链已不存在，可能已按保留策略清理。');
        setTrace(value);
      } catch (cause) { if (active) setTraceError(message(cause)); }
      finally { if (active) setTraceLoading(false); }
    })();
    return () => { active = false; };
  }, [effectiveId, selectedLiveTrace, traceReload]);
  const selectedTrace = selectedLiveTrace ?? (trace?.run.id === effectiveId ? trace : undefined);
  const headerRun = selectedTrace?.run ?? selectedRun;
  const usage = selectedTrace ? traceRunUsage(selectedTrace) : undefined;
  const usageLabel = usage?.state === 'pending' ? '待返回' : usage?.state === 'unrecorded' ? '未记录' : undefined;
  const totalTokens = usage?.inputTokens === undefined || usage.outputTokens === undefined ? undefined : usage.inputTokens + usage.outputTokens;
  const usedModels = useMemo(() => {
    const seen = new Set<string>();
    return (selectedTrace ? traceModelCallSpans(selectedTrace) : []).flatMap((span) => {
      const model = traceModelSnapshot(span);
      if (!model) return [];
      const key = model.configurationId + ':' + model.modelId + ':' + model.configurationUpdatedAt;
      if (seen.has(key)) return [];
      seen.add(key); return [model];
    });
  }, [selectedTrace]);

  return <section className={`run-history-page ${listOpen ? 'is-list-open' : 'is-list-collapsed'}`} aria-label="运行记录" aria-busy={loading}>
    <header className="run-history-header">
      <div><span className="monitoring-kicker">执行详情</span><h1>运行记录</h1><p>选择一轮任务，沿调用链查看模型、工具与执行结果。</p></div>
      <div className="run-history-header-actions"><Button icon={<PanelLeft size={14} />} autoInsertSpace={false} aria-expanded={listOpen} aria-controls="run-history-list" onClick={() => setListOpen((value) => !value)}>{listOpen ? '收起运行列表' : '展开运行列表'}</Button>{onBack && <Button icon={<ArrowLeft size={14} />} autoInsertSpace={false} onClick={onBack}>返回运行监测</Button>}<Tooltip title="刷新运行记录"><Button icon={<RefreshCw size={15} />} aria-label="刷新运行记录" loading={loading} onClick={() => { void load(); setTraceReload((value) => value + 1); }} /></Tooltip></div>
    </header>
    <div className="run-history-filters">
      <label className="run-history-search"><Search size={15} /><input aria-label="搜索运行记录" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索运行 ID、任务类型或会话 ID" /></label>
      <label className="run-history-filter"><span>时间</span><select aria-label="运行记录时间范围" value={range} onChange={(event) => setRange(event.target.value as Range)}><option value="all">最近记录</option><option value="24h">24 小时</option><option value="7d">7 天</option><option value="30d">30 天</option></select></label>
      <label className="run-history-filter"><span>状态</span><select aria-label="运行记录状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    </div>
    {error && <div className="run-history-error" role="alert"><TriangleAlert size={15} /><span>{error}{loaded ? '，当前保留上次读取的记录。' : ''}</span><Button size="small" onClick={() => void load()}>重试读取</Button></div>}
    <div className="run-history-layout">
      <aside id="run-history-list" className="run-history-list" aria-label="最近运行">
        <header><strong>最近运行</strong><span>{visibleRuns.length} / {recentRuns.length} 轮</span></header>
        <p className="run-history-list-note">最多读取最近 50 轮，筛选作用于这些记录。</p>
        <div className="run-history-list-scroll">{visibleRuns.map((run) => <button key={run.id} className={'monitoring-run-row ' + (effectiveId === run.id ? 'is-selected' : '')} onClick={() => { setSelectedId(run.id); if (compact.current) setListOpen(false); }} aria-pressed={effectiveId === run.id} aria-label={`${taskLabels[run.taskType ?? 'general'] ?? run.taskType}，${time(run.startedAt)}，${statusLabels[run.status]}，运行 ${run.id}`}>
          <span className={'monitoring-run-dot ' + run.status} /><span className="monitoring-run-main"><strong>{taskLabels[run.taskType ?? 'general'] ?? run.taskType}</strong><small>{time(run.startedAt)}</small><code title={run.id}>{run.id.slice(0, 8)}</code></span><span className="run-history-row-end"><span className={'run-status ' + run.status}>{statusLabels[run.status]}</span><span className="mono">{duration(run.durationMs)}</span></span><ChevronRight size={13} />
        </button>)}{!visibleRuns.length && <div className="run-history-empty"><Activity size={24} /><strong>{loading && !loaded ? '正在读取运行记录…' : error && !loaded ? '运行记录暂不可用' : recentRuns.length ? '没有匹配的运行' : '还没有运行记录'}</strong><span>{recentRuns.length ? '调整时间、状态或搜索条件后重试。' : '执行一次任务后，可以在这里查看调用链。'}</span>{recentRuns.length > 0 && <Button size="small" autoInsertSpace={false} onClick={() => { setRange('all'); setStatus('all'); setQuery(''); }}>清空筛选</Button>}</div>}</div>
      </aside>
      <section className="monitoring-trace run-history-detail" aria-label="调用链详情" aria-busy={traceLoading}>
        <header><div><strong>{headerRun ? '本轮调用链' : '调用链详情'}</strong><span className="run-history-selected-id">{headerRun ? headerRun.id : '选择一条运行记录'}</span>{headerRun && <small>{time(headerRun.startedAt)} · 会话 {headerRun.sessionId}</small>}</div>{headerRun && <span className={'run-status ' + headerRun.status}>{statusLabels[headerRun.status]}</span>}</header>
        <div className="run-history-detail-scroll">{selectedTrace ? <>
          <div className="monitoring-trace-meta"><span><small>运行耗时</small><strong>{duration(traceDuration(selectedTrace.run))}</strong></span><span><small>Token</small><strong>{usageLabel ?? integer(totalTokens)}</strong></span><span><small>预估成本</small><strong>{usageLabel ?? (usage?.cost === undefined ? '—' : '$' + usage.cost.toFixed(4))}</strong></span><span><small>节点</small><strong>{selectedTrace.spans.length}</strong></span><span><small>模型阶段</small><strong>{traceModelCallSpans(selectedTrace).length}</strong></span><span><small>工具调用</small><strong>{selectedTrace.spans.filter((span) => span.kind === 'tool').length}</strong></span></div>
          {usage?.state === 'unrecorded' && <p className="run-history-usage-note">本轮未记录到模型用量，不能据此判断实际消耗为零。</p>}
          {selectedTrace.run.errorMessage && <div className="monitoring-trace-error" role="status"><TriangleAlert size={15} /><div><strong>{selectedTrace.run.status === 'cancelled' ? '本轮执行已取消' : selectedTrace.run.status === 'failed' ? '本轮执行失败' : '本轮运行提示'}</strong><p>{selectedTrace.run.errorMessage}</p></div></div>}
          {usedModels.length > 0 && <div className="monitoring-model-snapshots" aria-label="本轮模型配置"><strong>本轮模型配置</strong>{usedModels.map((model, index) => <span key={index} title={'配置ID: ' + model.configurationId}><b className="mono">{model.modelId}</b><small>{model.name} · {model.provider}{model.legacyPresetRates ? ' · 沿用旧预设费率，请核对' : ''}</small></span>)}</div>}
          <TraceTimeline key={selectedTrace.run.id} trace={selectedTrace} defaultOpen />
          <RoutingClassificationFeedback trace={selectedTrace} />
        </> : traceError ? <div className="run-history-empty" role="alert"><TriangleAlert size={24} /><strong>调用链读取失败</strong><span>{traceError}</span><Button autoInsertSpace={false} onClick={() => setTraceReload((value) => value + 1)}>重试</Button></div> : <div className="run-history-empty"><Activity size={24} /><strong>{effectiveId ? '正在读取调用链…' : loading && !loaded ? '正在读取运行记录…' : recentRuns.length ? '没有匹配的运行' : '还没有运行记录'}</strong><span>{effectiveId ? '正在加载所选运行的完整执行记录。' : recentRuns.length ? '调整时间、状态或搜索条件后重试。' : '执行一次任务后，可以在这里查看调用链。'}</span>{!effectiveId && recentRuns.length > 0 && <Button autoInsertSpace={false} onClick={() => { setRange('all'); setStatus('all'); setQuery(''); }}>清空筛选</Button>}</div>}</div>
      </section>
    </div>
  </section>;
}
