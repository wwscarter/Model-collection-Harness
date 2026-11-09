import React, { useMemo, useState } from 'react';
import type { RunTrace, SpanKind, TraceSpan, TraceModelSnapshot } from '../types';

const kindLabels: Record<SpanKind, string> = {
  run: '运行', route: '路由', context: '上下文', memory: '记忆', compact: '压缩',
  plan: '规划', model: '模型', tool: '工具', synthesis: '合成', audit: '审计',
  verify: '项目验证', 'verify-command': '检查命令', 'verify-repair': '检查修复',
  hook: '钩子',
};
const statusClass: Record<string, string> = { success: 'ok', failed: 'bad', cancelled: 'warn', running: 'live' };
const duration = (value?: number) => value === undefined ? '—' : value < 1000 ? Math.round(value) + 'ms' : (value / 1000).toFixed(1) + 's';
const money = (value: number) => value > 0 ? '$' + value.toFixed(4) : '—';
const tokens = (value: number) => value > 0 ? value.toLocaleString('en-US') : '—';
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
  const tree = useMemo(() => {
    const spans = [...(trace?.spans ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const children = new Map<string | undefined, TraceSpan[]>();
    for (const span of spans) {
      const key = span.parentSpanId;
      children.set(key, [...(children.get(key) ?? []), span]);
    }
    return { spans, roots: children.get(undefined) ?? [], children };
  }, [trace]);
  const visible = useMemo(() => {
    if (filter === 'all') return undefined;
    const selected = new Set<string>();
    for (const span of tree.spans) {
      const matches = filter === 'error' ? span.status === 'failed' || span.status === 'cancelled' : span.kind === filter;
      if (matches) {
        selected.add(span.id);
        let parent = span.parentSpanId;
        while (parent) { selected.add(parent); parent = tree.spans.find((candidate) => candidate.id === parent)?.parentSpanId; }
      }
    }
    return selected;
  }, [filter, tree.spans]);

  if (!trace) return <div className="trace-empty">本轮没有可读取的调用链</div>;
  const totalInput = trace.run.totalInputTokens || tree.spans.reduce((sum, span) => sum + span.inputTokens, 0);
  const totalOutput = trace.run.totalOutputTokens || tree.spans.reduce((sum, span) => sum + span.outputTokens, 0);
  const totalCost = trace.run.totalCost || tree.spans.reduce((sum, span) => sum + span.cost, 0);
  const modelCalls = tree.spans.filter((span) => span.kind === 'model').length;
  const toolCalls = tree.spans.filter((span) => span.kind === 'tool').length;
  const failures = tree.spans.filter((span) => span.status === 'failed' || span.status === 'cancelled').length;
  const runStart = tree.spans.length ? new Date(tree.spans[0].startedAt).getTime() : 0;
  const runDuration = trace.run.durationMs ?? 0;
  const exportTrace = () => {
    const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'trace-' + trace.run.id + '.json'; anchor.click(); URL.revokeObjectURL(url);
  };
  const renderSpan = (span: TraceSpan, depth: number): React.ReactNode => {
    const children = tree.children.get(span.id) ?? [];
    if (visible && !visible.has(span.id)) return null;
    const offset = runStart ? Math.max(0, new Date(span.startedAt).getTime() - runStart) : 0;
    const left = runDuration ? Math.min(100, (offset / runDuration) * 100) : 0;
    const width = runDuration && span.durationMs ? Math.max(1, Math.min(100 - left, (span.durationMs / runDuration) * 100)) : 0;
    const open = expandedId === span.id;
    const model = traceModelSnapshot(span);
    const modelLabel = model?.modelId ?? (span.modelId ? '配置ID: ' + span.modelId : '—');
    return <React.Fragment key={span.id}>
      <button type="button" className={'trace-row trace-' + (statusClass[span.status] ?? 'idle') + (open ? ' is-expanded' : '')} style={{ paddingLeft: 8 + depth * 15 + 'px' }} onClick={() => setExpandedId(open ? undefined : span.id)} aria-expanded={open}>
        <i className="trace-status-dot" aria-hidden="true" />
        <span className="trace-kind">{kindLabels[span.kind] ?? span.kind}</span>
        <strong className="trace-name" title={span.errorMessage ?? undefined}>{span.name}</strong>
        <span className="trace-model mono" title={model ? model.name + ' · ' + model.provider + ' · 上游ID: ' + model.modelId + ' · 配置ID: ' + model.configurationId : span.modelId ? '历史记录仅保存配置ID: ' + span.modelId : undefined}>{modelLabel}</span>
        <span className="trace-waterfall" aria-hidden="true"><i style={{ marginLeft: left + '%', width: width + '%' }} /></span>
        <span className="trace-metric mono">{duration(span.durationMs)}</span>
        <span className="trace-metric mono">{tokens(span.inputTokens + span.outputTokens)}</span>
        <span className="trace-metric mono">{money(span.cost)}</span>
        <span className="trace-status-label">{span.status === 'failed' ? '失败' : span.status === 'cancelled' ? '取消' : span.status === 'running' ? '进行中' : ''}</span>
      </button>
      {open && <div className="trace-detail" style={{ marginLeft: 8 + depth * 15 + 'px' }}>
        <span><small>span</small><code>{span.id}</code></span>
        <span><small>状态</small><code>{span.status}</code></span>
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
        <span><small>token</small><code>{integer(span.inputTokens)} in / {integer(span.outputTokens)} out</code></span>
        {span.errorMessage && <span className="trace-detail-error"><small>错误</small><code>{span.errorMessage}</code></span>}
        {span.attributes && Object.keys(span.attributes).length > 0 && <pre>{JSON.stringify(span.attributes, null, 2)}</pre>}
      </div>}
      {children.map((child) => renderSpan(child, depth + 1))}
    </React.Fragment>;
  };
  const integer = (value: number) => value.toLocaleString('en-US');

  return <details className="trace-timeline" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span><strong>调用链</strong><small>{trace.run.status === 'running' ? '进行中 · ' : ''}{tree.spans.length} 步 · {modelCalls} 次模型 · {toolCalls} 次工具{failures ? ' · ' + failures + ' 个异常' : ''}</small></span>
      <span className="trace-summary-right"><span className="mono">{duration(runDuration)} · {tokens(totalInput + totalOutput)} tok · {money(totalCost)}</span><button type="button" className="trace-export" onClick={(event) => { event.preventDefault(); exportTrace(); }}>导出</button></span>
    </summary>
    <div className="trace-toolbar" role="group" aria-label="调用链筛选">{([['all', '全部'], ['model', '模型'], ['tool', '工具'], ['error', '异常']] as Array<[Filter, string]>).map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
    <div className="trace-body">{tree.roots.length ? tree.roots.map((span) => renderSpan(span, 0)) : <div className="trace-empty">本轮没有可读取的调用链</div>}</div>
  </details>;
}
