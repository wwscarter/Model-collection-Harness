import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import type { RunTrace, SpanKind, TraceSpan, TraceModelSnapshot } from '../types';
import { traceDuration, traceModelCallSpans, traceProblemCounts, traceRunUsage, traceSpanUsage, traceTiming, traceTree, type TraceUsage } from '../tracePresentation';
import '../styles/trace.css';

const kindLabels: Record<SpanKind, string> = {
  run: '运行', route: '路由', context: '上下文', memory: '记忆', compact: '压缩',
  plan: '规划', model: '模型', tool: '工具', synthesis: '合成', audit: '审计',
  verify: '项目验证', 'verify-command': '检查命令', 'verify-repair': '检查修复', hook: '钩子',
};
const statuses: Record<string, string> = { success: '成功', failed: '失败', cancelled: '取消', running: '进行中' };
const statusClass: Record<string, string> = { success: 'ok', failed: 'bad', cancelled: 'warn', running: 'live' };
const duration = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : value < 1000 ? Math.round(value) + 'ms' : (value / 1000).toFixed(1) + 's';
const money = (value?: number) => value === undefined ? '—' : '$' + value.toFixed(4);
const integer = (value?: number) => value === undefined ? '—' : value.toLocaleString('en-US');
const usageMissing = (usage?: TraceUsage) => usage?.state === 'pending' ? '待返回' : usage?.state === 'unrecorded' ? '未记录' : undefined;
const usageHint = (usage?: TraceUsage) => usage?.state === 'unrecorded' ? '调用未记录用量，不能据此判断实际消耗为零。' : usage?.state === 'pending' ? '等待本轮返回用量与费用。' : '已记录用量；费用按模型配置费率估算。';
const tokenTotal = (usage?: TraceUsage) => usage?.inputTokens === undefined || usage.outputTokens === undefined ? undefined : usage.inputTokens + usage.outputTokens;
type Filter = 'all' | 'model' | 'tool' | 'error';

interface Props { trace?: RunTrace; defaultOpen?: boolean; }

export function traceModelSnapshot(span: TraceSpan): TraceModelSnapshot | undefined {
  const value = span.attributes?.modelSnapshot;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const model = value as Record<string, unknown>;
  if (!['configurationId', 'modelId', 'name', 'provider'].every((key) => typeof model[key] === 'string' && model[key])) return undefined;
  return model as unknown as TraceModelSnapshot;
}

export function TraceTimeline({ trace, defaultOpen = false }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [expandedId, setExpandedId] = useState<string>();
  const [open, setOpen] = useState(defaultOpen);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { setExpandedId(undefined); setOpen(defaultOpen); }, [trace?.run.id, defaultOpen]);
  useEffect(() => {
    if (trace?.run.status !== 'running') return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [trace?.run.id, trace?.run.status]);
  const tree = useMemo(() => traceTree(trace?.spans ?? []), [trace?.spans]);
  const visible = useMemo(() => {
    if (filter === 'all') return undefined;
    const selected = new Set<string>();
    for (const span of tree.sorted) {
      const matches = filter === 'error' ? span.status === 'failed' || span.status === 'cancelled' : filter === 'model' ? span.kind === 'model' || (span.kind === 'audit' && span.name === 'model-verify') || (span.kind === 'memory' && span.name === 'memory.extract') : span.kind === filter;
      if (!matches) continue;
      selected.add(span.id);
      let parent = span.parentSpanId;
      const visited = new Set([span.id]);
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        selected.add(parent);
        parent = tree.byId.get(parent)?.parentSpanId;
      }
    }
    return selected;
  }, [filter, tree]);

  if (!trace) return <div className="trace-empty">本轮没有可读取的调用链</div>;
  const usage = traceRunUsage(trace);
  const problems = traceProblemCounts(trace);
  const modelCalls = traceModelCallSpans(trace).length;
  const toolCalls = tree.sorted.filter((span) => span.kind === 'tool').length;
  const timing = traceTiming(trace, now);
  const rows = tree.rows.filter(({ span }) => !visible || visible.has(span.id));
  const exportTrace = () => {
    const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'trace-' + trace.run.id + '.json'; anchor.click(); URL.revokeObjectURL(url);
  };

  const renderSpan = (span: TraceSpan, depth: number, detached: boolean) => {
    const start = Date.parse(span.startedAt);
    const offset = Number.isFinite(start) ? Math.max(0, start - timing.start) : undefined;
    const spanDuration = traceDuration(span, now);
    const left = timing.duration && offset !== undefined ? Math.min(100, (offset / timing.duration) * 100) : 0;
    const width = timing.duration && spanDuration !== undefined ? Math.min(100 - left, Math.max(spanDuration > 0 ? .5 : 0, (spanDuration / timing.duration) * 100)) : 0;
    const expanded = expandedId === span.id;
    const model = traceModelSnapshot(span);
    const modelLabel = model?.modelId ?? (span.modelId ? '配置ID: ' + span.modelId : '—');
    const spanUsage = span.kind === 'run' ? usage : traceSpanUsage(span);
    const usageLabel = usageMissing(spanUsage);
    return <React.Fragment key={span.id}>
      <button type="button" className={'trace-row trace-' + (statusClass[span.status] ?? 'idle') + (expanded ? ' is-expanded' : '')} onClick={() => setExpandedId(expanded ? undefined : span.id)} aria-expanded={expanded} aria-label={'查看 ' + span.name + ' 详情'} data-span-id={span.id} data-depth={depth}>
        <span className="trace-step" style={{ paddingLeft: Math.min(depth, 8) * 16 }}>
          {expanded ? <ChevronDown size={13} className="trace-expand" /> : <ChevronRight size={13} className="trace-expand" />}
          <i className="trace-status-dot" aria-hidden="true" />
          <span className="trace-step-copy"><strong className="trace-name" title={span.name}>{span.name}</strong><span className="trace-kind">{kindLabels[span.kind] ?? span.kind}{detached && <small title="此记录的父节点缺失或关联异常，仍显示已记录的步骤。"> · 独立节点</small>}</span></span>
        </span>
        <span className="trace-model mono" title={model ? model.name + ' · ' + model.provider + ' · 上游ID: ' + model.modelId + ' · 配置ID: ' + model.configurationId : span.modelId ? '历史记录仅保存配置ID: ' + span.modelId : undefined}>{modelLabel}</span>
        <span className="trace-timecell" title={'相对运行起点 ' + duration(offset) + '，持续 ' + duration(spanDuration)}>
          <span className="trace-offset mono">{offset === undefined ? '起点未记录' : '+' + duration(offset)}</span>
          <span className="trace-waterfall" aria-hidden="true"><i style={{ left: left + '%', width: width + '%' }} /></span>
        </span>
        <span className="trace-metric mono">{duration(spanDuration)}</span>
        <span className="trace-metric mono" title={spanUsage ? usageHint(spanUsage) : '此步骤不单独记录模型用量。'}>{usageLabel ?? integer(tokenTotal(spanUsage))}</span>
        <span className="trace-metric mono" title={spanUsage ? usageHint(spanUsage) : '此步骤不单独记录模型费用。'}>{usageLabel ?? money(spanUsage?.cost)}</span>
        <span className="trace-status-label">{statuses[span.status] ?? span.status}</span>
      </button>
      {expanded && <div className="trace-detail">
        <div className="trace-detail-heading"><strong>{kindLabels[span.kind]} · {span.name}</strong><span>{statuses[span.status]}</span></div>
        <span><small>Span ID</small><code>{span.id}</code></span>
        <span><small>父节点</small><code>{span.parentSpanId ?? '根节点'}</code></span>
        <span><small>开始时间</small><code>{span.startedAt}</code></span>
        <span><small>结束时间</small><code>{span.endedAt ?? (span.status === 'running' ? '执行中' : '未记录')}</code></span>
        {model ? <>
          <span><small>上游模型 ID</small><code>{model.modelId}</code></span>
          <span><small>配置 ID</small><code>{model.configurationId}</code></span>
          <span><small>配置名称</small><code>{model.name}</code></span>
          <span><small>提供商</small><code>{model.provider}</code></span>
          {model.endpointOrigin && <span><small>端点来源</small><code>{model.endpointOrigin}</code></span>}
          {model.costPer1kTokens && <span><small>预估费率 USD / 1K Token</small><code>输入 {model.costPer1kTokens.input} / 输出 {model.costPer1kTokens.output}</code></span>}
          {model.legacyPresetRates && <span className="trace-detail-note">当前调用沿用旧预设费率，请按服务商价格核对；显示费用为配置估算。</span>}
          {model.configurationUpdatedAt && <span><small>配置快照时间</small><code>{model.configurationUpdatedAt}</code></span>}
        </> : span.modelId && <><span><small>配置 ID</small><code>{span.modelId}</code></span><span className="trace-detail-note">历史记录未保存实际模型型号，无法由配置 ID 确认当时使用的上游模型。</span></>}
        {spanUsage && <span><small>Token 用量</small><code>{usageLabel ?? integer(spanUsage.inputTokens) + ' in / ' + integer(spanUsage.outputTokens) + ' out'}</code></span>}
        {usageLabel && <p className="trace-usage-note">{usageHint(spanUsage)}</p>}
        {span.errorMessage && <div className="trace-detail-error"><strong>错误详情</strong><pre>{span.errorMessage}</pre></div>}
        {span.attributes && Object.keys(span.attributes).length > 0 && <details className="trace-attributes"><summary>已记录属性与输入输出</summary><pre>{JSON.stringify(span.attributes, null, 2)}</pre></details>}
      </div>}
    </React.Fragment>;
  };

  return <details className="trace-timeline trace-inspector" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="trace-summary-copy"><strong>调用链 <ChevronDown size={14} /></strong><small>{tree.sorted.filter((span) => span.kind !== 'run').length} 个步骤 · {modelCalls} 个模型阶段 · {toolCalls} 次工具{problems.failedSteps ? ' · ' + problems.failedSteps + ' 个失败步骤' : ''}{problems.cancelledSteps ? ' · ' + problems.cancelledSteps + ' 个取消步骤' : ''}</small></span>
      <span className="trace-summary-right"><span className="mono" title={usageHint(usage)}>{duration(timing.runDuration)} · {usageMissing(usage) ?? integer(tokenTotal(usage)) + ' tok'} · {usageMissing(usage) ?? money(usage.cost)}</span><button type="button" className="trace-export" onClick={(event) => { event.preventDefault(); event.stopPropagation(); exportTrace(); }}><Download size={12} />导出</button></span>
    </summary>
    <div className="trace-toolbar">
      <div role="group" aria-label="调用链筛选">{([['all', '全部'], ['model', '模型'], ['tool', '工具'], ['error', '异常']] as Array<[Filter, string]>).map(([value, label]) => <button key={value} type="button" className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
      <span>{filter === 'all' ? '按父子层级展示，时序条共用运行起点' : '同时保留父节点，便于定位执行位置'}</span>
    </div>
    <div className="trace-body" tabIndex={0} role="region" aria-label="调用链步骤，可横向滚动查看完整列">
      <div className="trace-grid">
        <div className="trace-column-head" aria-hidden="true"><span>步骤 / 类型</span><span>实际模型 / 历史配置</span><span className="trace-axis"><span>相对时间</span><span className="mono">0 — {duration(timing.duration)}</span></span><span>耗时</span><span>Token</span><span>预估费用</span><span>状态</span></div>
        {rows.length ? rows.map(({ span, depth, detached }) => renderSpan(span, depth, detached)) : <div className="trace-empty">{tree.rows.length ? '没有符合当前筛选条件的步骤' : '本轮没有可读取的调用链'}</div>}
      </div>
    </div>
  </details>;
}
