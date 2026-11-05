import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, RefreshCw } from 'lucide-react';
import type { RoutingObservation, RoutingCorrection } from '@core/growth/RoutingLearningStore';
import type { LocalRoutingClassification } from '@core/routing/LocalRoutingModel';
import type { RunTrace } from '../types';
import { errorMessage } from '../format';

const taskLabels = { code: '代码实施', reasoning: '推理与规划', analysis: '分析与比较', review: '代码审查', creative: '创意写作', general: '日常交流' };
const complexityLabels = { low: '低', medium: '中', high: '高' };
type TaskType = keyof typeof taskLabels;
type Complexity = keyof typeof complexityLabels;
const taskType = (value: unknown): value is TaskType => typeof value === 'string' && Object.hasOwn(taskLabels, value);
const complexity = (value: unknown): value is Complexity => typeof value === 'string' && Object.hasOwn(complexityLabels, value);

function recordedClassification(trace: RunTrace): LocalRoutingClassification | undefined {
  for (const span of trace.spans.filter((candidate) => candidate.kind === 'route')) {
    const value = span.attributes?.classification;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (taskType(record.taskType) && complexity(record.complexity) && ['heuristic', 'ollama', 'local-model'].includes(String(record.backend))) return record as unknown as LocalRoutingClassification;
  }
  return undefined;
}

/** A fresh keyed editor prevents an old run's input or request from leaking into another run. */
export function RoutingClassificationFeedback({ trace }: { trace: RunTrace }) {
  return <RoutingFeedbackEditor key={trace.run.id} trace={trace} />;
}

function RoutingFeedbackEditor({ trace }: { trace: RunTrace }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [observation, setObservation] = useState<RoutingObservation>();
  const [correction, setCorrection] = useState<RoutingCorrection>();
  const [selectedTask, setSelectedTask] = useState<TaskType>('general');
  const [selectedComplexity, setSelectedComplexity] = useState<Complexity>('medium');
  const [loadError, setLoadError] = useState<string>();
  const [notice, setNotice] = useState<{ error: boolean; text: string }>();
  const mounted = useRef(false);
  const request = useRef(0);
  const classification = recordedClassification(trace);
  const hasLearning = Boolean(window.amd?.routingLearning);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current += 1; };
  }, []);

  const load = async () => {
    const revision = ++request.current;
    setLoading(true); setLoadError(undefined); setNotice(undefined);
    try {
      if (!window.amd?.routingLearning) return;
      const result = await window.amd.routingLearning.get(trace.run.id);
      if (!mounted.current || revision !== request.current) return;
      // Run identity is checked again even though the main process is the source of these records.
      const nextObservation = result?.observation?.runId === trace.run.id ? result.observation : undefined;
      const nextCorrection = result?.correction?.runId === trace.run.id ? result.correction : undefined;
      setObservation(nextObservation); setCorrection(nextCorrection);
      const prediction = nextCorrection?.expected ?? nextObservation?.classification ?? classification;
      if (taskType(prediction?.taskType)) setSelectedTask(prediction.taskType);
      if (complexity(prediction?.complexity)) setSelectedComplexity(prediction.complexity);
      setLoaded(true);
    } catch (cause) {
      if (mounted.current && revision === request.current) setLoadError(errorMessage(cause));
    } finally { if (mounted.current && revision === request.current) setLoading(false); }
  };
  const toggle = () => {
    if (!expanded && !loaded && !loading) void load();
    setExpanded((value) => !value);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!observation || saving) return;
    const revision = request.current;
    setSaving(true); setNotice(undefined);
    try {
      if (!window.amd?.routingLearning) throw new Error('分类反馈接口尚未连接');
      const saved = await window.amd.routingLearning.correct({ runId: trace.run.id, taskType: selectedTask, complexity: selectedComplexity });
      if (!mounted.current || revision !== request.current) return;
      if (saved.runId !== trace.run.id) throw new Error('保存结果不属于当前运行，请重新读取');
      setCorrection(saved); setNotice({ error: false, text: '纠正样本已保存到本机，后续可用于本地分类示例。' });
    } catch (cause) {
      if (mounted.current && revision === request.current) setNotice({ error: true, text: '保存失败，已保留选择：' + errorMessage(cause) });
    } finally { if (mounted.current && revision === request.current) setSaving(false); }
  };
  const exportSamples = async () => {
    setExporting(true); setNotice(undefined);
    try {
      if (!window.amd?.routingLearning) throw new Error('分类反馈接口尚未连接');
      const data = await window.amd.routingLearning.export();
      if (!mounted.current) return;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'routing-user-corrections-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.append(anchor);
      try { anchor.click(); } finally { anchor.remove(); URL.revokeObjectURL(url); }
      setNotice({ error: false, text: '已导出 ' + data.samples.length + ' 条已确认样本。' });
    } catch (cause) {
      if (mounted.current) setNotice({ error: true, text: '导出失败：' + errorMessage(cause) });
    } finally { if (mounted.current) setExporting(false); }
  };

  const backend = classification?.backend === 'ollama' ? '本机 Ollama' : classification?.backend === 'local-model' ? '本地模型' : '关键词规则';
  const taskText = observation?.description ?? correction?.description;
  const priorContext = observation?.priorContext ?? correction?.priorContext;
  const timestamp = correction && new Date(correction.createdAt);
  return <section className="routing-feedback" aria-label="本轮任务分类">
    <div className="routing-feedback-heading"><strong>本轮任务分类</strong>{hasLearning && <div><button type="button" className="button ghost small" aria-expanded={expanded} onClick={toggle}>纠正分类<ChevronDown size={12} className={expanded ? 'is-open' : ''} /></button><button type="button" className="button ghost small" disabled={exporting} onClick={() => void exportSamples()}><Download size={12} />{exporting ? '正在导出…' : '导出已确认样本'}</button></div>}</div>
    {classification ? <><div className="routing-classification-labels"><span>{taskLabels[classification.taskType]}</span><span>{complexityLabels[classification.complexity]}复杂度</span><small>{backend}{classification.model ? ' · ' + classification.model : ''}{classification.promptVersion ? ' · ' + classification.promptVersion : ''}</small></div>{classification.fallbackReason && <p className="routing-feedback-hint">本轮已回退规则：{classification.fallbackReason}</p>}</> : <p className="routing-feedback-hint">本轮未记录可展示的分类信息。</p>}
    {hasLearning && expanded && <div className="routing-feedback-editor">
      <p className="routing-feedback-hint">仅在你主动保存后记录任务与正确标签，供以后本地分类示例使用；不会训练模型权重，也不会发送到云端。任务执行成功不代表分类正确。</p>
      {loading ? <p role="status">正在读取本轮可纠正的输入…</p> : loadError ? <div role="alert"><p>分类输入读取失败：{loadError}</p><button type="button" className="button outline small" onClick={() => void load()}><RefreshCw size={12} />重试读取</button></div> : loaded && <>
        {taskText && <div className="routing-feedback-input"><strong>{observation ? '将保存的任务文本' : '已保存的任务文本'}</strong><p>{taskText.slice(0, 240)}{taskText.length > 240 ? '…' : ''}</p>{taskText.length > 240 && <details><summary>查看完整任务（最多 8,000 字符）</summary><pre>{taskText.slice(0, 8000)}</pre></details>}{priorContext && <details><summary>{observation ? '同时保存的必要上下文' : '已保存的必要上下文'}</summary><pre>{priorContext.slice(0, 2000)}</pre></details>}</div>}
        {correction && <p className="routing-feedback-hint">已确认：{taskLabels[correction.expected.taskType]} · {complexityLabels[correction.expected.complexity]}复杂度{timestamp && Number.isFinite(timestamp.getTime()) ? ' · ' + timestamp.toLocaleString('zh-CN') : ''}</p>}
        {observation ? <form onSubmit={(event) => void save(event)}><fieldset disabled={saving} className="routing-feedback-fields"><label className="field"><span className="field-label">正确任务类型</span><select className="input" aria-label="正确任务类型" value={selectedTask} onChange={(event) => { setSelectedTask(event.target.value as TaskType); setNotice(undefined); }}>{Object.entries(taskLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field"><span className="field-label">正确复杂度</span><select className="input" aria-label="正确复杂度" value={selectedComplexity} onChange={(event) => { setSelectedComplexity(event.target.value as Complexity); setNotice(undefined); }}>{Object.entries(complexityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button type="submit" className="button outline small">{saving ? '正在保存…' : '保存纠正样本（仅本机）'}</button></fieldset></form> : <p className="routing-feedback-hint">当前轮未保留可纠正的输入，可能来自历史记录或应用已重启；不会从其他会话补取任务文本。</p>}
      </>}
    </div>}
    {notice && <p className="routing-feedback-notice" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
  </section>;
}
