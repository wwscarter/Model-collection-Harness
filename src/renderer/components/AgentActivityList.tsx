import React, { useId, useState } from 'react';
import { ChevronDown, Clock3 } from 'lucide-react';
import type { AgentActivity, ActivityTool } from '@core/agent/RunActivity';
import { AgentGlyph } from './AgentGlyph';
import { OutputView } from './OutputView';
import { ToolCallList } from './ToolCallList';
import '../styles/agent-activity.css';

const statusLabels: Record<AgentActivity['status'], string> = { queued: '等待中', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
const toolLabels: Record<string, string> = { read: '读取文件', ls: '查看目录', grep: '搜索文件', find: '查找文件', code_search: '检索代码', code_symbols: '查看符号', web_search: '搜索网页', web_fetch: '读取网页', run_command: '执行命令', process_status: '查看进程', write: '写入文件', edit: '编辑文件', request_media: '生成素材' };
const durationLabel = (value?: number) => value === undefined || !Number.isFinite(value) ? undefined : value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(1) + ' s';

function latestActivity(agent: AgentActivity): string {
  const tool = agent.tools?.slice().reverse().find((item) => item.status === 'running') ?? agent.tools?.at(-1);
  if (tool) return toolActivity(tool);
  if (agent.status === 'queued') return '等待执行';
  if (agent.status === 'running') return agent.task || '正在处理分配的任务';
  if (agent.status === 'failed') return agent.error || '执行未完成，可展开查看';
  if (agent.status === 'cancelled') return '任务已停止';
  return agent.content ? '已提交报告' : '执行结束';
}

function toolActivity(tool: ActivityTool): string {
  const action = toolLabels[tool.toolName] ?? tool.toolName;
  const progress = tool.status === 'running' ? '正在' : tool.status === 'failed' ? '未能' : '已';
  return progress + action + (tool.label ? ' · ' + tool.label : '');
}

function AgentActivityRow({ agent, index }: { agent: AgentActivity; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const title = agent.role || agent.modelName || '子智能体 ' + (index + 1);
  const model = agent.actualModelId || agent.modelName || agent.modelId;
  const duration = durationLabel(agent.durationMs);
  return <details className="agent-activity" open={expanded} data-status={agent.status}>
    <summary className="agent-activity-summary" aria-expanded={expanded} aria-controls={detailId} onClick={(event) => { event.preventDefault(); setExpanded((value) => !value); }}>
      <AgentGlyph identity={agent.id} running={agent.status === 'running'} />
      <span className="agent-activity-identity"><strong>{title}</strong><span className="agent-activity-model" title={model}>{model}</span></span>
      <span className="agent-activity-current" title={latestActivity(agent)}>{latestActivity(agent)}</span>
      <span className={'activity-status is-' + agent.status}>{agent.status === 'running' && <i aria-hidden="true" />}{statusLabels[agent.status]}</span>
      <ChevronDown className="activity-chevron" size={13} aria-hidden="true" />
    </summary>
    <div id={detailId} className="agent-activity-detail">
      <dl className="activity-facts"><div><dt>实际模型</dt><dd>{model}</dd></div>{agent.task && <div><dt>分配任务</dt><dd>{agent.task}</dd></div>}{duration && <div><dt>耗时</dt><dd><Clock3 size={12} aria-hidden="true" />{duration}</dd></div>}{agent.stopReason && <div><dt>结束原因</dt><dd>{agent.stopReason}</dd></div>}</dl>
      {!!agent.tools?.length && <div className="agent-activity-tools"><h4>工具活动</h4><ToolCallList tools={agent.tools} /></div>}
      {agent.content ? <div className="agent-activity-report"><h4>子智能体报告</h4><div className="agent-activity-output" tabIndex={0} role="region" aria-label={title + '的报告'}><OutputView content={agent.content} loading={agent.status === 'running'} emptyState={false} /></div></div>
        : <p className="activity-placeholder">{agent.status === 'queued' ? '任务开始后会显示活动与报告。' : agent.status === 'running' ? '正在执行，活动和报告会在这里更新。' : '没有返回报告。'}</p>}
      {agent.error && <p className="activity-error">{agent.error}</p>}
    </div>
  </details>;
}

/** Durable, expandable worker activity attached to the answer it belongs to. */
export function AgentActivityList({ agents }: { agents: AgentActivity[] }) {
  if (!agents.length) return null;
  const completed = agents.filter((agent) => agent.status === 'completed').length;
  return <section className="agent-activities" aria-label="子智能体活动">
    <div className="activity-list-heading"><span>子智能体</span><span>{completed}/{agents.length} 已完成</span></div>
    {agents.map((agent, index) => <AgentActivityRow key={agent.id} agent={agent} index={index} />)}
  </section>;
}
