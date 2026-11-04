import React from 'react';
import { ArrowUp, Check, ChevronDown, FileText, Folder, GitBranch, Laptop, Plus, Sparkles, Square, X } from 'lucide-react';
import type { ModelConfig, ProjectInfo } from '../types';

interface AgentInputBarProps {
  project?: ProjectInfo;
  value: string;
  inputRef: React.Ref<HTMLTextAreaElement>;
  hasMessages: boolean;
  busy: boolean;
  running: boolean;
  editing: boolean;
  collaborationControl: React.ReactNode;
  collaborationPicker: React.ReactNode;
  multiModel: boolean;
  pinnedModelId?: string;
  models: ModelConfig[];
  onToggleMultiModel: () => void;
  onSelectModel: (id: string) => void;
  includeProjectContext: boolean;
  onToggleProjectContext: () => void;
  notice: string | null;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  onOpenContext: () => void;
  onCancelEdit: () => void;
}

export function AgentInputBar({ project, value, inputRef, hasMessages, busy, running, editing, collaborationControl, collaborationPicker, multiModel, pinnedModelId, models, onToggleMultiModel, onSelectModel, includeProjectContext, onToggleProjectContext, notice, onChange, onKeyDown, onSend, onStop, onOpenContext, onCancelEdit }: AgentInputBarProps) {
  const branch = project?.git?.branch ?? project?.git?.head;
  return <section className="composer" aria-label="任务输入">
    <div className="composer-tabs">
      <button className="composer-tab" title={project?.root ?? '选择本地项目'} onClick={onOpenContext}><Folder size={14} /><span>{project?.name ?? '选择项目'}</span></button>
      {project && <button className={`composer-tab context-toggle ${includeProjectContext ? 'active' : ''}`} aria-pressed={includeProjectContext} title={includeProjectContext ? '本次发送项目文件快照（已排除 .env/.npmrc/credentials 等凭据文件），点击关闭' : '本次不发送项目文件快照'} onClick={onToggleProjectContext}><FileText size={13} /><span>上下文 {includeProjectContext ? '开' : '关'}</span></button>}
      <span className="context-separator h-1 w-1 rounded-full bg-slate-300" aria-hidden="true" />
      <span className="composer-tab static"><Laptop size={14} /><span>本地</span></span>
      {branch && <><span className="context-separator h-1 w-1 rounded-full bg-slate-300" aria-hidden="true" /><span className="composer-tab static context-branch" title={project?.git?.detached ? '当前 Git 提交' : '当前 Git 分支'}><GitBranch size={14} /><span>{branch}</span></span></>}
    </div>
    <div className="prompt-card">
      {editing && <div className="prompt-editing-bar"><span>编辑消息 · 重新发送后将生成新的回复</span><button className="message-icon-button" title="取消编辑" aria-label="取消编辑" onClick={onCancelEdit}><X size={15} /></button></div>}
      {notice && <div className="collaboration-notice" role="status">{notice}</div>}
      {collaborationPicker}
      <textarea ref={inputRef} rows={2} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} placeholder={hasMessages ? '输入追加指令或反馈，让想法继续向前…' : '描述你想完成的任务，newAi 会和你一起实现…'} aria-label={editing ? '编辑消息' : '描述任务'} />
      <footer>
        <div className="dock-left"><button className="attach-button" title="添加项目上下文" aria-label="添加项目上下文" onClick={onOpenContext}><Plus size={18} /></button>{collaborationControl}</div>
        <div className="dock-right"><div className="session-routing"><button className={'routing-mode-toggle ' + (multiModel ? 'is-multi' : 'is-single')} title={multiModel ? '关闭多模型调度，选择单一模型' : '开启多模型调度'} aria-label={multiModel ? '关闭多模型调度' : '开启多模型调度'} onClick={onToggleMultiModel}>{multiModel ? '多模型' : '单模型'}</button>{multiModel ? <span className="model-display" aria-label="自动路由" title="DeepSeek 会根据任务自动分配模型"><Sparkles size={12} aria-hidden="true" /><span>自动调度</span></span> : <label className="session-model-picker"><select value={pinnedModelId ?? models[0]?.id ?? ''} onChange={(event) => onSelectModel(event.target.value)} aria-label="当前会话模型">{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select><ChevronDown size={11} /></label>}</div><button className="send-button" title={running ? '停止任务' : busy ? '另一个会话正在执行' : editing ? '重新生成回复' : '执行任务'} aria-label={running ? '停止任务' : editing ? '重新生成回复' : '执行任务'} disabled={!running && (busy || !value.trim())} onClick={running ? onStop : onSend}>{running ? <Square size={13} fill="currentColor" /> : editing ? <Check size={17} /> : <ArrowUp size={17} strokeWidth={2.2} />}</button></div>
      </footer>
    </div>
    <div className="composer-hint"><span><kbd>Enter</kbd> 发送 <span className="hint-divider">·</span> <kbd>Shift + Enter</kbd> 换行</span><span>让每一个想法，向前一步</span></div>
  </section>;
}
