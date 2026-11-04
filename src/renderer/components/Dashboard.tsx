import React, { useCallback, useEffect, useMemo, useState } from 'react';

export interface DashboardSnapshot {
  range: { from?: string | Date; to?: string | Date };
  summary: { totalTasks: number; totalInvocations: number; totalCost: number; successRate: number; avgLatency: number; auditCount?: number; auditPassRate?: number };
  modelUsage: Array<{ modelId: string; invocations: number; totalCost: number; successRate: number; share?: number }>;
  costTrend: Array<{ bucket: string; totalCost: number; invocations: number; totalTokens: number }>;
  recent: Array<{ id: string; taskId: string; modelId: string; startTime: string | Date; inputTokens: number; outputTokens: number; totalCost: number; status: string; latency?: number }>;
}

interface DashboardProps { onClose: () => void; }

const money = (value: number) => `$${value.toFixed(4)}`;
const latency = (value: number) => value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;

export function Dashboard({ onClose }: DashboardProps) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('7d');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      if (!window.amd?.getDashboard) throw new Error('监测接口尚未连接');
      const result = await window.amd.getDashboard({ range });
      setSnapshot(result as DashboardSnapshot);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [range]);
  useEffect(() => { void load(); }, [load]);

  const maxCost = useMemo(() => Math.max(0.0001, ...(snapshot?.costTrend.map(item => item.totalCost) || [0])), [snapshot]);
  const exportReport = async () => {
    try {
      const markdown = await window.amd?.getReportMarkdown?.({ range });
      if (!markdown) return;
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `amd-report-${range}.md`; anchor.click(); URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return <div className="dashboard-overlay"><section className="dashboard-window">
    <header className="dashboard-header"><div><div className="eyebrow">OBSERVABILITY</div><h2>运行监测</h2><p>模型选择、成本和任务质量的本地汇总。</p></div><div className="dashboard-actions"><select value={range} onChange={(event) => setRange(event.target.value as typeof range)}><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option></select><button onClick={() => void load()}>刷新</button><button onClick={() => void exportReport()}>导出报告</button><button className="close-button" onClick={onClose}>×</button></div></header>
    {loading ? <div className="dashboard-state"><span className="loader-orb">✦</span><strong>正在读取本地指标…</strong></div> : error ? <div className="dashboard-state error-state"><strong>监测数据暂不可用</strong><span>{error}</span><button onClick={() => void load()}>重试</button></div> : snapshot && <>
      <div className="dashboard-kpis"><article><span>任务数</span><strong>{snapshot.summary.totalTasks}</strong><small>{snapshot.summary.totalInvocations} 次模型调用</small></article><article><span>总成本</span><strong>{money(snapshot.summary.totalCost)}</strong><small>当前时间范围</small></article><article><span>成功率</span><strong>{(snapshot.summary.successRate * 100).toFixed(1)}%</strong><small>按调用统计</small></article><article><span>平均延迟</span><strong>{latency(snapshot.summary.avgLatency)}</strong><small>从开始到完成</small></article><article><span>代码审计通过率</span><strong>{snapshot.summary.auditCount ? `${((snapshot.summary.auditPassRate ?? 0) * 100).toFixed(1)}%` : '—'}</strong><small>{snapshot.summary.auditCount ? '含代码的回答（静态审计）' : '尚无含代码的回答'}</small></article></div>
      <div className="dashboard-grid"><section className="dashboard-card"><div className="dashboard-card-heading"><div><span className="section-kicker">COST TREND</span><h3>成本趋势</h3></div><span className="dashboard-muted">{snapshot.costTrend.length} 个时间点</span></div><div className="trend-chart">{snapshot.costTrend.length ? snapshot.costTrend.map((item) => <div className="trend-column" key={item.bucket} title={`${item.bucket}: ${money(item.totalCost)}`}><i style={{ height: `${Math.max(5, item.totalCost / maxCost * 100)}%` }} /><span>{item.bucket.slice(5)}</span></div>) : <div className="empty-chart">还没有调用数据</div>}</div></section><section className="dashboard-card"><div className="dashboard-card-heading"><div><span className="section-kicker">MODEL DISTRIBUTION</span><h3>模型使用</h3></div></div><div className="model-usage-list">{snapshot.modelUsage.length ? snapshot.modelUsage.map((model) => <div className="model-usage-row" key={model.modelId}><div className="usage-label"><strong>{model.modelId}</strong><span>{model.invocations} 次 · {money(model.totalCost)}</span></div><div className="usage-meter"><i style={{ width: `${Math.max(3, Math.round((model.share ?? model.successRate) * 100))}%` }} /></div></div>) : <div className="empty-chart">还没有调用数据</div>}</div></section></div>
      <section className="dashboard-card recent-card"><div className="dashboard-card-heading"><div><span className="section-kicker">RECENT INVOCATIONS</span><h3>最近调用</h3></div></div><div className="recent-table"><div className="recent-row recent-head"><span>任务</span><span>模型</span><span>Token</span><span>成本</span><span>状态</span></div>{snapshot.recent.length ? snapshot.recent.map((item) => <div className="recent-row" key={item.id}><span title={item.taskId}>{item.taskId.slice(0, 18)}</span><span>{item.modelId}</span><span>{item.inputTokens + item.outputTokens}</span><span>{money(item.totalCost)}</span><span className={item.status === 'success' ? 'status-good' : 'status-bad'}>{item.status === 'success' ? '成功' : item.status}</span></div>) : <div className="empty-table">还没有执行记录</div>}</div></section>
    </>}
  </section></div>;
}
