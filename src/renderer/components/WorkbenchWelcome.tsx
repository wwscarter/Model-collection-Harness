import React from 'react';
import { ArrowUpRight, Code2, FolderCode, FolderOpen, ListTodo, Sparkles } from 'lucide-react';

const suggestions = [
  { icon: FolderCode, title: '读懂一个项目', subtitle: '梳理结构，找到关键入口', prompt: '请帮我梳理当前项目的目录结构、主要模块与运行入口，并给出阅读代码的建议。' },
  { icon: Code2, title: '打磨一段代码', subtitle: '理清实现，让代码更清晰', prompt: '我想改进一段代码。请先帮我分析它的逻辑和可维护性，再一起讨论改进方案。' },
  { icon: ListTodo, title: '推进一个想法', subtitle: '把需求拆成可执行的步骤', prompt: '我想实现一个新功能。请帮我澄清需求、拆解任务，并规划可以逐步验证的实现步骤。' },
];

export function WorkbenchWelcome({ projectName, onChoose, onOpenProject }: { projectName?: string; onChoose: (prompt: string) => void; onOpenProject: () => void }) {
  return <section className="workbench-welcome" aria-label="开始工作">
    <div className="welcome-symbol"><Sparkles size={27} strokeWidth={1.5} /><span aria-hidden="true" /></div>
    <span className="welcome-eyebrow" title={projectName}>{projectName ? `当前项目 · ${projectName}` : '一个工作空间，无限种可能'}</span>
    <h2>你的下一个想法，从这里开始。</h2>
    <p>与 newAi 一起思考、编写和构建。<br />把复杂的任务，变成清晰的下一步。</p>
    <div className="welcome-suggestions grid grid-cols-3 gap-3">{suggestions.map(({ icon: Icon, title, subtitle, prompt }) => <button key={title} className="welcome-suggestion" onClick={() => onChoose(prompt)}><span className="suggestion-icon"><Icon size={19} strokeWidth={1.6} /></span><strong>{title}</strong><span>{subtitle}</span><ArrowUpRight className="suggestion-arrow" size={14} /></button>)}</div>
    <button className="welcome-project-link" onClick={onOpenProject}><FolderOpen size={14} />{projectName ? '查看当前项目文件' : '选择本地项目，让回答更了解你的上下文'}<ArrowUpRight size={12} /></button>
  </section>;
}
