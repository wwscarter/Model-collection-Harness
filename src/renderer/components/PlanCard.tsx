import React, { useEffect, useState } from 'react';
import { Check, ListChecks, Plus, X } from 'lucide-react';
import type { PlanDecision, PlanStep, RunPlan } from '@core/planning/PlanTypes';
import { errorMessage } from '../format';

const statuses = { ready: '计划已生成', awaiting: '等待确认', approved: '已确认', executing: '正在执行', completed: '本轮已结束', cancelled: '已取消', failed: '本轮未完成' };
const stepStatuses = { pending: '待执行', running: '执行中', done: '已完成', skipped: '已跳过' };

export function PlanCard({ record, active = false, onDecision }: { record: RunPlan; active?: boolean; onDecision(decision: PlanDecision): Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PlanStep[]>(record.plan.steps);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { setDraft(record.plan.steps); setEditing(false); setError(undefined); }, [record.runId, record.version]);
  const waiting = active && record.status === 'awaiting';
  const decide = async (action: PlanDecision['action']) => {
    setBusy(true); setError(undefined);
    try { await onDecision({ runId: record.runId, version: record.version, action, ...(action === 'edit' ? { steps: draft } : {}) }); if (action === 'edit') setEditing(false); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const update = (index: number, values: Partial<PlanStep>) => setDraft((steps) => steps.map((step, position) => position === index ? { ...step, ...values } : step));
  return <section className="runtime-card execution-plan" aria-label="执行计划">
    <div className="runtime-card-heading"><div><h3><ListChecks size={16} />执行计划 <small>版本 {record.version}</small></h3><p>{record.executionMode === 'only' ? '仅规划 · 未执行工具或项目修改' : statuses[record.status]}</p></div><span className="runtime-hint">{record.plan.verify ? '包含复核' : '常规检查'}</span></div>
    {record.plan.reason && <p className="runtime-hint">{record.plan.reason}</p>}
    <ol className="plan-steps">{(editing ? draft : record.plan.steps).map((step, index) => <li key={step.id}>
      {editing ? <div className="field"><label className="field-label">步骤 {index + 1}<input className="input" aria-label={'计划步骤 ' + (index + 1)} value={step.title} maxLength={200} disabled={busy} onChange={(event) => update(index, { title: event.target.value })} /></label><textarea className="input" aria-label={'步骤说明 ' + (index + 1)} rows={2} value={step.detail ?? ''} maxLength={2000} disabled={busy} onChange={(event) => update(index, { detail: event.target.value })} /><button className="button ghost small" disabled={busy || draft.length === 1} onClick={() => setDraft((steps) => steps.filter((_, position) => position !== index))}><X size={12} />删除步骤</button></div>
        : <div><strong>{step.status === 'done' && <Check size={13} />}{step.title}</strong><span className="runtime-hint"> · {stepStatuses[step.status]}</span>{step.detail && <p className="runtime-hint" style={{ whiteSpace: 'pre-wrap' }}>{step.detail}</p>}</div>}
    </li>)}</ol>
    {!!record.plan.subagents.length && <details><summary className="runtime-hint">子智能体分工（{record.plan.subagents.length}）</summary>{record.plan.subagents.map((agent) => <p key={agent.modelId} className="runtime-hint"><strong>{agent.role}</strong> · {agent.instruction}</p>)}</details>}
    {waiting && <div className="routing-config-footer">{editing ? <><button className="button outline small" disabled={busy || draft.length >= 24} onClick={() => setDraft((steps) => [...steps, { id: 'step-' + crypto.randomUUID().slice(0, 8), title: '', status: 'pending' }])}><Plus size={12} />添加步骤</button><button className="button primary small" disabled={busy || !draft.length || draft.some((step) => !step.title.trim())} onClick={() => void decide('edit')}>保存修改</button><button className="button ghost small" disabled={busy} onClick={() => { setDraft(record.plan.steps); setEditing(false); }}>放弃修改</button></> : <><button className="button primary small" disabled={busy} onClick={() => void decide('approve')}>执行计划</button>{record.editable !== false && <button className="button outline small" disabled={busy} onClick={() => setEditing(true)}>修改计划</button>}</>}<button className="button ghost small" disabled={busy} onClick={() => void decide('cancel')}>取消任务</button></div>}
    {waiting && record.editable === false && <p className="runtime-hint">如需调整生成要求，请取消后重新发送。</p>}
    {record.status === 'awaiting' && !active && <p className="runtime-hint">该轮等待已经结束，可重新发送任务生成新计划。</p>}
    {waiting && <p className="runtime-hint">等待确认期间暂停运行时间预算，30 分钟未确认将自动取消。</p>}
    {error && <div className="runtime-notice" role="alert">{error}</div>}
  </section>;
}
