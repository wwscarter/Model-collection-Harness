import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChevronRight, Clock3, Coins, RefreshCw, TriangleAlert } from 'lucide-react';
import type { DashboardSnapshot, RunTrace, TraceRun } from '../types';
import { TraceTimeline } from '../components/TraceTimeline';

type Range = '24h' | '7d' | '30d';
interface MonitoringPageProps { liveTrace?: RunTrace; }

const duration = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(1) + ' s';
const money = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : '$' + value.toFixed(4);
const integer = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString('en-US');
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const statusLabel: Record<string, string> = { success: '成功', failed: '失败', cancelled: '取消', running: '进行中' };

export function MonitoringPage({ liveTrace }: MonitoringPageProps) {
  const [range, setRange] = useState<Range>('7d');
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [runs, setRuns] = useState<TraceRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(liveTrace?.run.id);
  const [trace, setTrace] = useState<RunTrace>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [traceError, setTraceError] = useState<string>();
  const [traceReload, setTraceReload] = useState(0);
  const loadRequest = useRef(0);
  const liveTraceRef = useRef(liveTrace);
  liveTraceRef.current = liveTrace;

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true); setError(undefined);
    try {
      if (!window.amd?.getDashboard || !window.amd.trace?.list) throw new Error('监测接口尚未连接');
      const [dashboard, recent] = await Promise.all([
        window.amd.getDashboard({ range }),
        window.amd.trace.list(50),
      ]);
      if (request !== loadRequest.current) return;
      setSnapshot(dashboard);
      const from = new Date(dashboard.range.from).getTime();
      const to = new Date(dashboard.range.to).getTime();
      const inRange = (run: TraceRun) => {
        const started = new Date(run.startedAt).getTime();
        return (!Number.isFinite(from) || started >= from) && (!Number.isFinite(to) || started <= to);
      };
      const live = liveTraceRef.current?.run;
      const next = recent.filter(inRange);
      if (live && inRange(live)) {
        const index = next.findIndex((run) => run.id === live.id);
        if (index >= 0) next[index] = live;
        else next.unshift(live);
      }
      setRuns(next);
      setSelectedId((current) => current && next.some((run) => run.id === current) ? current : next[0]?.id);
    } catch (cause) { if (request === loadRequest.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (request === loadRequest.current) setLoading(false); }
  }, [range]);
  useEffect(() => {
    void load();
    return () => { loadRequest.current += 1; };
  }, [load, liveTrace?.run.id, liveTrace?.run.status]);
  useEffect(() => {
    if (liveTrace) setSelectedId(liveTrace.run.id);
  }, [liveTrace?.run.id]);
  const selectedLiveTrace = liveTrace?.run.id === selectedId ? liveTrace : undefined;
  useEffect(() => {
    setTraceError(undefined);
    if (!selectedId) { setTrace(undefined); return; }
    if (selectedLiveTrace) { setTrace(selectedLiveTrace); return; }
    setTrace(undefined);
    let active = true;
    void window.amd?.trace?.get(selectedId).then((value) => { if (active) setTrace(value); }).catch((cause) => {
      if (active) setTraceError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [selectedId, selectedLiveTrace, traceReload]);
  const selectedTrace = trace?.run.id === selectedId ? trace : undefined;

  const totals = useMemo(() => {
    const totalTokens = runs.reduce((sum, run) => sum + run.totalInputTokens + run.totalOutputTokens, 0);
    const failures = runs.filter((run) => run.status === 'failed').length;
    return { totalTokens, failures };
  }, [runs]);
  const selectedRun = selectedTrace?.run ?? runs.find((run) => run.id === selectedId);
  const summary = snapshot?.summary;
  const models = (snapshot?.modelUsage ?? []).slice(0, 5);

  return <section className="monitoring-page" aria-label="运行监测" aria-busy={loading}>
    <header className="monitoring-header">
      <div><h1>运行监测</h1><p>只保留判断运行质量所需的指标；调用链、成本与失败原因集中在右侧。</p></div>
      <div className="monitoring-actions"><div className="monitoring-range" role="group" aria-label="统计范围">{([['24h', '24 小时'], ['7d', '7 天'], ['30d', '30 天']] as Array<[Range, string]>).map(([value, label]) => <button key={value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{label}</button>)}</div><button className="icon-button" title="刷新" aria-label="刷新运行监测" onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spinning' : ''} /></button></div>
    </header>

    {error && <div className="monitoring-error" role="alert"><TriangleAlert size={15} />{error}</div>}

    <div className="monitoring-metrics" aria-label="关键指标">
      <div><span><Activity size={13} />运行轮次</span><strong>{integer(summary?.totalTasks)}</strong><small>{summary?.totalInvocations ?? 0} 次模型调用</small></div>
      <div><span><ChevronRight size={13} />调用成功率</span><strong>{summary?.successRate === undefined ? '—' : Math.round(summary.successRate * 100) + '%'}</strong><small>最近 {runs.length} 轮中 {totals.failures} 个失败</small></div>
      <div><span><Clock3 size={13} />平均调用耗时</span><strong>{duration(summary?.avgLatency)}</strong><small>最近 {runs.length} 轮 · {integer(totals.totalTokens)} tok</small></div>
      <div><span><Coins size={13} />预估成本</span><strong>{money(summary?.totalCost)}</strong><small>{models.length ? models[0].modelId : '暂无模型数据'}</small></div>
    </div>

    <div className="monitoring-grid">
      <section className="monitoring-runs" aria-label="最近运行">
        <header><strong>最近运行</strong><span>{runs.length ? '选择一轮查看调用链' : '暂无运行记录'}</span></header>
        <div className="monitoring-run-list">
          {runs.map((run) => <button key={run.id} className={'monitoring-run-row ' + (selectedId === run.id ? 'is-selected' : '')} onClick={() => setSelectedId(run.id)}>
            <span className={'monitoring-run-dot ' + run.status} />
            <span className="monitoring-run-main"><strong>{run.taskType || 'general'}</strong><small>{time(run.startedAt)} · {run.complexity || 'auto'}</small></span>
            <span className="monitoring-run-model mono" title={run.id}>{run.id.slice(0, 8)}</span>
            <span className="monitoring-run-metric mono">{duration(run.durationMs)}</span>
            <span className="monitoring-run-status">{statusLabel[run.status] ?? run.status}</span>
          </button>)}
          {!runs.length && <div className="monitoring-empty"><Activity size={20} /><span>完成一次任务后，这里会出现运行记录。</span></div>}
        </div>
        <div className="monitoring-model-breakdown"><strong>模型分布</strong>{models.map((model) => <div key={model.modelId}><span className="mono" title={model.modelId}>{model.modelId}</span><i><b style={{ width: Math.round((model.share ?? 0) * 100) + '%' }} /></i><small>{Math.round((model.share ?? 0) * 100)}%</small></div>)}</div>
      </section>

      <section className="monitoring-trace" aria-label="调用链详情">
        <header><div><strong>{selectedRun ? '本轮调用链' : '调用链'}</strong><span>{selectedRun ? selectedRun.id : '选择左侧运行查看详情'}</span></div>{selectedRun && <span className={'monitoring-trace-status ' + selectedRun.status}>{statusLabel[selectedRun.status] ?? selectedRun.status}</span>}</header>
        {selectedTrace ? <>
          <div className="monitoring-trace-meta">
            <span><small>耗时</small><strong>{duration(selectedTrace.run.durationMs)}</strong></span>
            <span><small>Token</small><strong>{integer(selectedTrace.run.totalInputTokens + selectedTrace.run.totalOutputTokens)}</strong></span>
            <span><small>成本</small><strong>{money(selectedTrace.run.totalCost)}</strong></span>
            <span><small>Span</small><strong>{selectedTrace.spans.length}</strong></span>
            <span><small>模型调用</small><strong>{selectedTrace.spans.filter((span) => span.kind === 'model').length}</strong></span>
            <span><small>工具</small><strong>{selectedTrace.spans.filter((span) => span.kind === 'tool').length}</strong></span>
          </div>
          {selectedTrace.run.errorMessage && <div className="monitoring-trace-error">{selectedTrace.run.errorMessage}</div>}
          <TraceTimeline trace={selectedTrace} defaultOpen />
        </> : traceError ? <div className="monitoring-empty" role="alert"><span>{traceError}</span><button className="button outline" onClick={() => setTraceReload((value) => value + 1)}>重试</button></div> : <div className="monitoring-empty"><ChevronRight size={20} /><span>{selectedId ? '正在读取调用链…' : '选择一条运行记录，展开完整调用链。'}</span></div>}
      </section>
    </div>
  </section>;
}
