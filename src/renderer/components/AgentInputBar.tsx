import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, Folder, FolderPlus, GitBranch, LoaderCircle, Plus, ShieldCheck, Sparkles, Square, X } from 'lucide-react';
import type { ModelConfig, ProjectInfo, ProjectRecord } from '../types';
import type { VerificationMode } from '../verificationTypes';

interface AgentInputBarProps {
  value: string;
  inputRef: React.Ref<HTMLTextAreaElement>;
  hasMessages: boolean;
  busy: boolean;
  running: boolean;
  editing: boolean;
  multiModel: boolean;
  pinnedModelId?: string;
  models: ModelConfig[];
  project?: ProjectInfo;
  activeFilePath?: string;
  projects: ProjectRecord[];
  onSelectProject: (id: string) => void;
  gitBusy: boolean;
  onInitGit: () => void;
  approvalMode: 'ask' | 'auto' | 'full';
  verificationMode: VerificationMode;
  onVerificationModeChange: (mode: VerificationMode) => void;
  onOpenSettings: () => void;
  onToggleMultiModel: () => void;
  onSelectModel: (id: string) => void;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  onCancelEdit: () => void;
}

const QUICK_COMMANDS = [
  { label: '解释当前文件', prompt: '请解释当前打开文件的实现、关键流程和潜在风险。', requiresFile: true },
  { label: '审查当前改动', prompt: '请审查当前工作区未提交的改动，指出问题并给出修复建议。' },
  { label: '运行测试并修复', prompt: '请运行项目测试，定位失败原因并修复。' },
  { label: '梳理项目结构', prompt: '请梳理当前项目的目录结构、主要模块和运行入口，并给出阅读代码的建议。' },
];

export function AgentInputBar({ value, inputRef, hasMessages, busy, running, editing, multiModel, pinnedModelId, models, project, activeFilePath, projects, onSelectProject, gitBusy, onInitGit, approvalMode, verificationMode, onVerificationModeChange, onOpenSettings, onToggleMultiModel, onSelectModel, onChange, onKeyDown, onSend, onStop, onCancelEdit }: AgentInputBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen && !quickOpen && !projectMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.model-menu, .model-menu-trigger')) setMenuOpen(false);
      if (!event.target.closest('.quick-menu, .quick-menu-trigger')) setQuickOpen(false);
      if (!event.target.closest('.project-menu, .project-menu-trigger')) setProjectMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen, quickOpen, projectMenuOpen]);
  const insertCommand = (promptText: string) => {
    onChange(value.trim() ? value.replace(/\s*$/, '') + '\n\n' + promptText : promptText);
    setQuickOpen(false);
  };
  const selected = models.find((model) => model.id === pinnedModelId) ?? models[0];
  const label = multiModel ? '自动调度' : selected?.modelId || selected?.name || '选择模型';
  const permissionLabel = approvalMode === 'full' ? '完全控制' : approvalMode === 'auto' ? '帮我批准' : '请求批准';
  return <section className="composer" aria-label="任务输入">
    <div className="prompt-card">
      {editing && <div className="prompt-editing-bar"><span>编辑消息 · 重新发送后将生成新的回复</span><button className="message-icon-button" title="取消编辑" aria-label="取消编辑" onClick={onCancelEdit}><X size={15} /></button></div>}
      <div className="composer-contextbar">
        <div className="composer-project-wrap">
          <button className="composer-project-main project-menu-trigger" title={project?.root || '关联本地项目'} aria-label={project ? '当前项目：' + project.name : '关联本地项目'} aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((open) => !open)}>{project ? <Folder size={13} strokeWidth={1.7} /> : <FolderPlus size={13} strokeWidth={1.7} />}<span>{project?.name || '关联项目'}</span><ChevronDown size={10} className={projectMenuOpen ? 'is-open' : ''} /></button>
          {projectMenuOpen && <div className="project-menu" role="menu" aria-label="选择关联项目">{projects.map((item) => <button key={item.id} className={'project-menu-item ' + (project?.id === item.id ? 'is-active' : '')} role="menuitemradio" aria-checked={project?.id === item.id} title={item.displayRoot} onClick={() => { onSelectProject(item.id); setProjectMenuOpen(false); }}><Folder size={12} strokeWidth={1.7} /><span>{item.name}</span>{project?.id === item.id && <Check size={12} />}</button>)}{!projects.length && <div className="project-menu-empty">还没有项目，请在左侧「本地项目」中新建</div>}<div className="project-menu-hint">选择当前会话使用的项目</div></div>}
        </div>
        {project && (project.git ? <span className="composer-git-state" title={project.git.branch || project.git.head || 'Git'}><GitBranch size={12} strokeWidth={1.7} />{project.git.branch || 'Git'}</span>
          : <button className="composer-git-create" disabled={gitBusy} onClick={onInitGit}>{gitBusy ? <LoaderCircle size={12} className="spinning" /> : null}{gitBusy ? '创建中…' : '创建 Git 存储库'}</button>)}
        <label className="composer-git-state">验证 <select className="composer-git-create" aria-label="项目验证模式" title="快速检查 lint 与类型；完整检查再运行测试" value={verificationMode} disabled={busy} onChange={(event) => onVerificationModeChange(event.target.value as VerificationMode)}><option value="off">关闭</option><option value="quick">快速</option><option value="full">完整</option></select></label>
      </div>
      <textarea ref={inputRef} rows={2} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} placeholder={hasMessages ? '输入追加指令或反馈…' : '描述你想完成的任务…'} aria-label={editing ? '编辑消息' : '描述任务'} />
      <footer>
        <div className="dock-left quick-menu-wrap"><button className="attach-button quick-menu-trigger" title="快捷指令" aria-label="快捷指令" aria-expanded={quickOpen} onClick={() => setQuickOpen((open) => !open)}><Plus size={18} /></button>{quickOpen && <div className="quick-menu" role="menu" aria-label="快捷指令">{QUICK_COMMANDS.map((command) => <button key={command.label} className="quick-menu-item" role="menuitem" disabled={command.requiresFile && !activeFilePath} title={command.requiresFile && !activeFilePath ? '请先从工作区打开一个文件' : undefined} onClick={() => insertCommand(command.requiresFile ? `请解释项目文件「${activeFilePath}」的实现、关键流程和潜在风险。` : command.prompt)}>{command.label}</button>)}</div>}<button className="composer-permission" title="执行权限设置" aria-label={'执行权限：' + permissionLabel} onClick={onOpenSettings}><ShieldCheck size={12} strokeWidth={1.7} /><span>{permissionLabel}</span></button></div>
        <div className="dock-right">
          <div className="model-menu-wrap">
            <button className="model-menu-trigger" aria-label="切换模型" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>{multiModel ? <Sparkles size={12} /> : null}<span>{label}</span><ChevronDown size={11} className={menuOpen ? 'is-open' : ''} /></button>
            {menuOpen && <div className="model-menu" ref={menuRef} role="menu" aria-label="模型选择">
              <button className={'model-menu-item ' + (multiModel ? 'is-active' : '')} role="menuitemradio" aria-checked={multiModel} onClick={() => { if (!multiModel) onToggleMultiModel(); setMenuOpen(false); }}><span><strong>多模型调度</strong><small>按任务选择模型并安排分工</small></span>{multiModel && <Check size={12} />}</button>
              <div className="model-menu-separator" />
              {models.map((model) => <button key={model.id} className={'model-menu-item ' + (!multiModel && selected?.id === model.id ? 'is-active' : '')} role="menuitemradio" aria-checked={!multiModel && selected?.id === model.id} onClick={() => { onSelectModel(model.id); setMenuOpen(false); }}><span><strong>{model.modelId || model.name}</strong><small>{model.name === model.modelId ? model.provider : model.name + ' · ' + model.provider}</small></span>{!multiModel && selected?.id === model.id && <Check size={12} />}</button>)}
              {!models.length && <div className="model-menu-empty">先在设置中启用模型</div>}
            </div>}
          </div>
          <button className="send-button" title={running ? '停止任务' : busy ? '另一个会话正在执行' : editing ? '重新生成回复' : '执行任务'} aria-label={running ? '停止任务' : editing ? '重新生成回复' : '执行任务'} disabled={!running && (busy || !value.trim())} onClick={running ? onStop : onSend}>{running ? <Square size={13} fill="currentColor" /> : editing ? <Check size={17} /> : <ArrowUp size={17} strokeWidth={2.2} />}</button>
        </div>
      </footer>
    </div>
  </section>;
}
