import React from 'react';
import { Activity, ArrowUpRight, Clock3, Cpu, Star } from 'lucide-react';
import type { ModelConfig, SessionMetrics } from '../types';
import '../styles/inspector.css';

interface DetailsPanelProps {
  model?: string;
  modelConfig?: ModelConfig;
  planningModelName?: string;
  metrics?: SessionMetrics;
  modelId?: string;
  confidence?: number;
  running?: boolean;
  error?: string | null;
  rating?: number;
  onRate?: (rating: number) => void;
}

const integer = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString('en-US');
const duration = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;

export function DetailsPanel({ model, modelConfig, planningModelName, metrics, modelId, confidence, running, error, rating, onRate }: DetailsPanelProps) {
  const currentModel = modelConfig?.name || model;
  const confidencePercent = confidence === undefined || !Number.isFinite(confidence) ? undefined : Math.round(Math.min(1, Math.max(0, confidence)) * 1000) / 10;
  const status = running ? '实时计算中' : error ? '执行失败' : metrics ? '任务已完成' : '等待任务';
  const statusClass = running ? 'is-live' : error ? 'is-failed' : metrics ? 'is-complete' : 'is-idle';

  return <section className="inspector-details" aria-label="运行详情">
    <header className="inspector-details-header">
      <h3><Activity size={14} strokeWidth={1.8} />运行详情</h3>
      <span className={`inspector-runtime-status ${statusClass}`} role="status" title={!running && error ? error : undefined}>
        <i />{status}{running && <small>Streaming</small>}
      </span>
    </header>

    <section className="inspector-route-card" aria-label="模型路由">
      <div className="inspector-route-heading"><span>最终执行模型</span><span className="inspector-route-tag">{planningModelName ? '规划 + 执行' : '自动路由'}</span></div>
      <div className="inspector-model">
        <span className="inspector-model-icon"><Cpu size={15} strokeWidth={1.8} /></span>
        <div className="inspector-model-copy">
          <strong title={currentModel}>{currentModel || (running ? '正在选择执行模型' : '等待模型路由')}</strong>
          {planningModelName ? <small title={planningModelName}>规划：{planningModelName}</small> : modelConfig ? <small title={`${modelConfig.provider} · ${modelConfig.modelId}`}>{modelConfig.provider} · {modelConfig.modelId}</small> : <small>根据任务自动选择合适的模型</small>}
        </div>
      </div>
      <div className="inspector-confidence"><span>路由置信度</span><strong>{confidencePercent === undefined ? '—' : `${confidencePercent}%`}</strong></div>
      <div className="inspector-confidence-track" aria-hidden="true"><i style={{ width: `${confidencePercent ?? 0}%` }} /></div>
    </section>

    <dl className="inspector-metrics" aria-label="本次运行指标">
      <div><dt>输入 Token</dt><dd>{integer(metrics?.inputTokens)}</dd></div>
      <div className="is-output"><dt>输出 Token{running && <ArrowUpRight size={12} aria-hidden="true" />}</dt><dd>{integer(metrics?.outputTokens)}</dd></div>
      <div><dt>{running ? '已用时' : '总耗时'}</dt><dd>{duration(metrics?.latencyMs)}</dd></div>
      <div><dt>预估成本 <span>USD</span></dt><dd>{metrics?.cost === undefined || !Number.isFinite(metrics.cost) ? '—' : `$${metrics.cost.toFixed(4)}`}</dd></div>
    </dl>

    <div className="inspector-first-token"><span><Clock3 size={11} />首字延迟</span><strong>{metrics?.ttftMs === undefined && running ? '等待首字' : duration(metrics?.ttftMs)}</strong></div>

    <div className="inspector-feedback" aria-label="任务反馈">
      <span>{rating ? '感谢你的反馈' : '这次结果有帮助吗？'}</span>
      <div className="inspector-rating">{[1, 2, 3, 4, 5].map((value) => <button key={value} type="button" title={`${value} 星`} aria-label={`${value} 星`} aria-pressed={rating === value} className={rating && value <= rating ? 'is-rated' : ''} disabled={!modelId || running || Boolean(error) || !onRate} onClick={() => onRate?.(value)}><Star size={13} strokeWidth={1.6} fill={rating && value <= rating ? 'currentColor' : 'none'} /></button>)}</div>
    </div>
  </section>;
}
