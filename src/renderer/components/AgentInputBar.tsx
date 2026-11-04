import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, Plus, Sparkles, Square, X } from 'lucide-react';
import type { ModelConfig } from '../types';

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
  onToggleMultiModel: () => void;
  onSelectModel: (id: string) => void;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  onOpenContext: () => void;
  onCancelEdit: () => void;
}

export function AgentInputBar({ value, inputRef, hasMessages, busy, running, editing, multiModel, pinnedModelId, models, onToggleMultiModel, onSelectModel, onChange, onKeyDown, onSend, onStop, onOpenContext, onCancelEdit }: AgentInputBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Element && !event.target.closest('.model-menu, .model-menu-trigger')) setMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  const selected = models.find((model) => model.id === pinnedModelId) ?? models[0];
  const label = multiModel ? '自动调度' : selected?.name ?? '选择模型';
  return <section className="composer" aria-label="任务输入">
    <div className="prompt-card">
      {editing && <div className="prompt-editing-bar"><span>编辑消息 · 重新发送后将生成新的回复</span><button className="message-icon-button" title="取消编辑" aria-label="取消编辑" onClick={onCancelEdit}><X size={15} /></button></div>}
      <textarea ref={inputRef} rows={2} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} placeholder={hasMessages ? '输入追加指令或反馈…' : '描述你想完成的任务…'} aria-label={editing ? '编辑消息' : '描述任务'} />
      <footer>
        <div className="dock-left"><button className="attach-button" title="添加项目上下文" aria-label="添加项目上下文" onClick={onOpenContext}><Plus size={18} /></button></div>
        <div className="dock-right">
          <div className="model-menu-wrap">
            <button className="model-menu-trigger" aria-label="切换模型" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>{multiModel ? <Sparkles size={12} /> : null}<span>{label}</span><ChevronDown size={11} className={menuOpen ? 'is-open' : ''} /></button>
            {menuOpen && <div className="model-menu" ref={menuRef} role="menu" aria-label="模型选择">
              <button className={'model-menu-item ' + (multiModel ? 'is-active' : '')} role="menuitemradio" aria-checked={multiModel} onClick={() => { if (!multiModel) onToggleMultiModel(); setMenuOpen(false); }}><span><strong>多模型调度</strong><small>DeepSeek 负责任务分配</small></span>{multiModel && <Check size={12} />}</button>
              <div className="model-menu-separator" />
              {models.map((model) => <button key={model.id} className={'model-menu-item ' + (!multiModel && selected?.id === model.id ? 'is-active' : '')} role="menuitemradio" aria-checked={!multiModel && selected?.id === model.id} onClick={() => { onSelectModel(model.id); setMenuOpen(false); }}><span><strong>{model.name}</strong><small>{model.provider}</small></span>{!multiModel && selected?.id === model.id && <Check size={12} />}</button>)}
              {!models.length && <div className="model-menu-empty">先在设置中启用模型</div>}
            </div>}
          </div>
          <button className="send-button" title={running ? '停止任务' : busy ? '另一个会话正在执行' : editing ? '重新生成回复' : '执行任务'} aria-label={running ? '停止任务' : editing ? '重新生成回复' : '执行任务'} disabled={!running && (busy || !value.trim())} onClick={running ? onStop : onSend}>{running ? <Square size={13} fill="currentColor" /> : editing ? <Check size={17} /> : <ArrowUp size={17} strokeWidth={2.2} />}</button>
        </div>
      </footer>
    </div>
  </section>;
}
