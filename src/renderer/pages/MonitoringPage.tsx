import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Tooltip } from 'antd';
import { Activity, ArrowUpRight, CheckCheck, Clock3, Coins, GitBranch, RefreshCw, TriangleAlert } from 'lucide-react';
import type { DashboardSnapshot, RunTrace } from '../types';
import { OperationAuditPanel } from '../components/OperationAuditPanel';
import '../styles/monitoring.css';

type Range = '24h' | '7d' | '30d';
interface MonitoringPageProps { liveTrace?: RunTrace; onOpenRuns?: () => void; }
const duration = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(1) + ' s';
const integer = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString('en-US');
const rangeLabels: Record<Range, string> = { '24h': '24 小时', '7d': '7 天', '30d': '30 天' };

export function MonitoringPage({ liveTrace, onOpenRuns }: MonitoringPageProps) {
  const [range, setRange] = useState<Range>('7d');
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const load = useCallback(async () => {
    const revision = ++request.current;
    setLoading(true); setError(undefined); setSnapshot(undefined);
    try {
      if (!window.amd?.getDashboard) throw new Error('监测接口尚未连接');
      const value = await window.amd.getDashboard({ range });
      if (revision === request.current) setSnapshot(value);
    } catch (cause) {
      if (revision === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (revision === request.current) setLoading(false); }
  }, [range]);
  useEffect(() => {
    void load();
    return () => { request.current += 1; };
  }, [load, liveTrace?.run.id, liveTrace?.run.status]);

  const summary = snapshot?.summary;
  const models = snapshot?.modelUsage ?? [];
  const invocations = summary?.totalInvocations ?? 0;
  const recordedTokens = snapshot?.costTrend.reduce((sum, bucket) => sum + bucket.totalTokens, 0);
  return <section className="monitoring-page monitoring-overview" aria-label="运行监测" aria-busy={loading}>
    <header className="monitoring-header">
      <div><span className="monitoring-kicker">运行概览</span><h1>运行监测</h1><p>查看所选时间范围内的任务质量、模型调用和预估成本。</p></div>
      <div className="monitoring-actions"><OperationAuditPanel /><div className="monitoring-range ant-btn-group" role="group" aria-label="统计范围">{(Object.entries(rangeLabels) as Array<[Range, string]>).map(([value, label]) => <Button key={value} type={range === value ? 'primary' : 'default'} autoInsertSpace={false} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</Button>)}</div><Tooltip title="刷新运行监测"><Button type="text" className="icon-button" aria-label="刷新运行监测" loading={loading} icon={<RefreshCw size={15} />} onClick={() => void load()} /></Tooltip></div>
    </header>
    {error && <div className="monitoring-error" role="alert"><TriangleAlert size={15} /><span>{error}</span><Button size="small" onClick={() => void load()}>重试</Button></div>}
    <div className="monitoring-metrics" aria-label="关键指标">
      <div><span><Activity size={14} />运行轮次</span><strong>{integer(summary?.totalTasks)}</strong><small>所选范围内记录的任务</small></div>
      <div><span><CheckCheck size={14} />模型调用成功率</span><strong>{!summary || !invocations ? '—' : Math.round(summary.successRate * 100) + '%'}</strong><small>{summary ? integer(invocations) + ' 次模型调用' : loading ? '正在读取统计' : '统计暂不可用'}</small></div>
      <div><span><Clock3 size={14} />平均调用耗时</span><strong>{!summary || !invocations ? '—' : duration(summary.avgLatency)}</strong><small>{recordedTokens === undefined ? '按模型调用统计' : integer(recordedTokens) + ' Token 已记录'}</small></div>
      <div><span><Coins size={14} />预估成本</span><strong>{summary ? '$' + summary.totalCost.toFixed(4) : '—'}</strong><small>按调用时配置费率估算</small></div>
      <div><span><CheckCheck size={14} />验证通过率</span><strong>{summary?.verificationPassRate === undefined ? '—' : Math.round(summary.verificationPassRate * 100) + '%'}</strong><small>{summary ? `${summary.verificationCount ?? 0} 轮已验证 · ${summary.verificationUnverified ?? 0} 轮未验证` : loading ? '正在读取验证结果' : '验证结果暂不可用'}</small></div>
    </div>
    <div className="monitoring-overview-grid">
      <section className="monitoring-usage-card" aria-label="模型配置分布">
        <header><div><h2>模型配置分布</h2><p>所选范围内的模型调用，按保存的配置 ID 汇总。</p></div><span>{models.length} 个配置</span></header>
        <div className="monitoring-model-breakdown"><strong className="sr-only">模型配置分布</strong>{models.length ? models.map((model) => {
          const share = Math.max(0, Math.min(1, model.share ?? (invocations ? model.invocations / invocations : 0)));
          return <div key={model.modelId}><span className="mono" title={'配置 ID: ' + model.modelId}>配置ID: {model.modelId}</span><i><b style={{ width: Math.round(share * 100) + '%' }} /></i><small>{Math.round(share * 100)}%</small><span className="monitoring-usage-count">{integer(model.invocations)} 次调用</span></div>;
        }) : <p className="monitoring-overview-empty">{loading ? '正在读取模型调用…' : error ? '暂时无法读取模型调用。' : '此时间范围内还没有模型调用记录。'}</p>}</div>
      </section>
      <section className="monitoring-history-entry" aria-label="查看运行记录">
        <span className="monitoring-entry-icon"><GitBranch size={24} /></span><h2>查看每一次执行</h2><p>在独立页面选择运行，查看完整调用链、实际模型、节点耗时和错误详情。</p>
        <Button type="primary" icon={<ArrowUpRight size={15} />} onClick={onOpenRuns} disabled={!onOpenRuns} autoInsertSpace={false}>查看运行记录与调用链</Button>
        <small>运行记录展示最近 50 轮任务，统计范围与本页汇总独立。</small>
      </section>
    </div>
  </section>;
}
