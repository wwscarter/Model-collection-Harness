import React, { useMemo } from 'react';
import type { RunTrace, SpanKind, TraceSpan } from '../types';

const kindLabels: Record<SpanKind, string> = {
  run: '运行', route: '路由', context: '上下文', memory: '记忆', compact: '压缩',
  plan: '规划', model: '模型', tool: '工具', synthesis: '合成', audit: '审计',
};

const statusClass: Record<string, string> = { success: 'ok', failed: 'bad', cancelled: 'warn', running: 'live' };

const duration = (value?: number) => value === undefined ? '—' : value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
const money = (value: number) => value > 0 ? `$${value.toFixed(4)}` : '—';
const tokens = (value: number) => value > 0 ? value.toLocaleString('en-US') : '—';

interface Props { trace?: RunTrace; }

export function TraceTimeline({ trace }: Props) {
  const tree = useMemo(() => {
    const spans = [...(trace?.spans ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const children = new Map<string | undefined, TraceSpan[]>();
    for (const span of spans) {
      const key = span.parentSpanId;
      children.set(key, [...(children.get(key) ?? []), span]);
    }
    const roots = children.get(undefined) ?? [];
    return { spans, roots, children };
  }, [trace]);

  if (!trace) return null;
  const totalInput = trace.run.totalInputTokens || tree.spans.reduce((sum, span) => sum + span.inputTokens, 0);
  const totalOutput = trace.run.totalOutputTokens || tree.spans.reduce((sum, span) => sum + span.outputTokens, 0);
  const totalCost = trace.run.totalCost || tree.spans.reduce((sum, span) => sum + span.cost, 0);
  const started = trace.run.startedAt ? new Date(trace.run.startedAt).getTime() : 0;
  const latestEnd = tree.spans.reduce((latest, span) => Math.max(latest, span.endedAt ? new Date(span.endedAt).getTime() : 0), 0);
  const runDuration = trace.run.durationMs ?? (started ? Math.max(0, (latestEnd || Date.now()) - started) : undefined);
  const exportTrace = () => {
    const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `trace-${trace.run.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const renderSpan = (span: TraceSpan, depth: number): React.ReactNode => {
    const children = tree.children.get(span.id) ?? [];
    return <React.Fragment key={span.id}>
      <div className={`trace-row trace-${statusClass[span.status] ?? 'idle'}`} style={{ paddingLeft: `${8 + depth * 16}px` }}>
        <i className="trace-status-dot" aria-hidden="true" />
        <span className="trace-kind">{kindLabels[span.kind] ?? span.kind}</span>
        <strong className="trace-name" title={span.errorMessage ?? undefined}>{span.name}</strong>
        {span.modelId && <span className="trace-model mono" title={span.modelId}>{span.modelId}</span>}
        <span className="trace-metric mono">{duration(span.durationMs)}</span>
        <span className="trace-metric mono">{tokens(span.inputTokens + span.outputTokens)} tok</span>
        <span className="trace-metric mono">{money(span.cost)}</span>
        {span.status === 'failed' && <span className="trace-failed">失败</span>}
        {span.status === 'cancelled' && <span className="trace-failed">取消</span>}
      </div>
      {children.map((child) => renderSpan(child, depth + 1))}
    </React.Fragment>;
  };

  return <details className="trace-timeline" open>
    <summary>
      <span><strong>调用链</strong><small>{trace.run.status === 'running' ? '进行中 · ' : ''}{tree.spans.length} 步 · {tree.spans.filter((span) => span.kind === 'model').length} 次模型调用</small></span>
      <span className="trace-summary-right"><span className="mono">{duration(runDuration)} · {tokens(totalInput + totalOutput)} tok · {money(totalCost)}</span><button type="button" className="trace-export" onClick={(event) => { event.preventDefault(); exportTrace(); }}>导出</button></span>
    </summary>
    <div className="trace-body">
      {tree.roots.length ? tree.roots.map((span) => renderSpan(span, 0)) : <div className="trace-empty">本轮没有可读取的调用链</div>}
    </div>
  </details>;
}
