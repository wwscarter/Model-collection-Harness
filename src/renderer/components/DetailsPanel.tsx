import React from 'react';
import { Sparkles, Star } from 'lucide-react';
import { ModelConfig, SessionMetrics } from '../types';

interface DetailsPanelProps {
  model?: string;
  modelConfig?: ModelConfig;
  planningModelName?: string;
  metrics?: SessionMetrics;
  modelId?: string;
  confidence?: number;
  running?: boolean;
  rating?: number;
  onRate?: (rating: number) => void;
}

const integer = (value?: number) => value === undefined ? '—' : Math.round(value).toLocaleString('en-US');

export function DetailsPanel({ model, modelConfig, planningModelName, metrics, modelId, confidence, running, rating, onRate }: DetailsPanelProps) {
  const currentModel = modelConfig?.name || model || '自动路由';
  const confidencePercent = confidence === undefined ? undefined : Math.round(confidence * 1000) / 10;
  const status = running ? { label: '实时计算中 (Streaming)', live: true } : metrics ? { label: '已完成', live: false } : { label: '等待任务', live: false };
  return <section className="details-panel" aria-label="运行详情">
    <div className="details-header"><h3>运行详情</h3><span className={`status-pill ${status.live ? '' : 'muted'}`}><i className={status.live ? 'live-dot pulse' : 'live-dot'} />{status.label}</span></div>
    <section className="detail-card">
      <div className="detail-card-heading"><span>最终执行模型</span><span className="tag-chip">{planningModelName ? '规划 + 执行' : '自动路由'}</span></div>
      <div className="model-name"><span className="model-orb"><Sparkles size={13} /></span><div><strong>{currentModel}</strong><small>{planningModelName ? `规划：${planningModelName}` : modelConfig ? `${modelConfig.provider} · ${modelConfig.modelId}` : '智能路由 · 等待任务'}</small></div></div>
      <div className="confidence"><span>路由置信度</span><strong>{confidencePercent === undefined ? '—' : `${confidencePercent}%`}</strong></div>
      <div className="meter"><i style={{ width: confidencePercent === undefined ? '0%' : `${Math.min(100, confidencePercent)}%` }} /></div>
    </section>
    <section className="detail-card">
      <div className="detail-card-heading"><span>本次指标</span></div>
      <div className="metric-grid">
        <div><span>输入 Token</span><strong>{integer(metrics?.inputTokens)}</strong></div>
        <div><span>输出 Token</span><strong className="accent-text">{integer(metrics?.outputTokens)}</strong></div>
        <div><span>延迟</span><strong>{metrics?.latencyMs === undefined ? '—' : metrics.latencyMs < 1000 ? `${Math.round(metrics.latencyMs)} ms` : `${(metrics.latencyMs / 1000).toFixed(1)} s`}</strong></div>
        <div><span>预估成本</span><strong>{metrics?.cost == null ? '—' : `$${metrics.cost.toFixed(4)}`}</strong></div>
      </div>
    </section>
    <section className="detail-card feedback-card" aria-label="任务反馈">
      <span className="feedback-copy">这次结果有帮助吗？</span>
      <div className="rating-row">{[1, 2, 3, 4, 5].map((value) => <button key={value} aria-label={`${value} 星`} className={rating && value <= rating ? 'rated' : ''} disabled={!modelId || running} onClick={() => onRate?.(value)}><Star size={15} fill={rating && value <= rating ? 'currentColor' : 'none'} /></button>)}</div>
    </section>
  </section>;
}
