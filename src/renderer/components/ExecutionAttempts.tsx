import React, { useId, useState } from 'react';
import { ArrowRight, ArrowRightLeft, ChevronDown } from 'lucide-react';
import type { ExecutionAttempt } from '@core/agent/RunActivity';
import '../styles/agent-activity.css';

const statusLabels: Record<ExecutionAttempt['status'], string> = { running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
const durationLabel = (value?: number) => value === undefined || !Number.isFinite(value) ? undefined : value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(1) + ' s';

/** Main-model retries and fallbacks are separate from delegated worker activity. */
export function ExecutionAttempts({ attempts }: { attempts: ExecutionAttempt[] }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  if (attempts.length < 2 && !attempts.some((attempt) => attempt.status === 'failed' || attempt.status === 'cancelled')) return null;
  return <details className="execution-attempts" open={expanded} aria-label="主模型切换">
    <summary className="execution-attempts-summary" aria-expanded={expanded} aria-controls={detailId} onClick={(event) => { event.preventDefault(); setExpanded((value) => !value); }}>
      <ArrowRightLeft size={14} aria-hidden="true" /><strong>{attempts.length > 1 ? '主模型切换' : '主模型执行'}</strong>
      <span className="execution-model-path">{attempts.map((attempt, index) => <React.Fragment key={attempt.id}>{index > 0 && <ArrowRight size={11} aria-hidden="true" />}<span title={attempt.actualModelId}>{attempt.actualModelId}</span></React.Fragment>)}</span>
      <ChevronDown className="activity-chevron" size={13} aria-hidden="true" />
    </summary>
    <div className="execution-attempts-detail" id={detailId}><ol>{attempts.map((attempt) => {
      const duration = durationLabel(attempt.durationMs);
      return <li key={attempt.id} data-status={attempt.status}>
        <div className="execution-attempt-row"><span className="execution-attempt-number">{attempt.index + 1}</span><strong>{attempt.actualModelId}</strong><span className={'activity-status is-' + attempt.status}>{statusLabels[attempt.status]}</span>{duration && <small>{duration}</small>}</div>
        {attempt.reason && <p className="execution-attempt-reason">{attempt.reason}</p>}{attempt.error && <p className="activity-error">{attempt.error}</p>}
      </li>;
    })}</ol></div>
  </details>;
}
