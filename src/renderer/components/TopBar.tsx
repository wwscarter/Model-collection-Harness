import React from 'react';
import { FileCode2, FileText, PanelRight, X } from 'lucide-react';

export interface OpenFileTab { path: string; name: string; }

interface TopBarProps {
  title: string;
  tabs: OpenFileTab[];
  activePath?: string;
  rightOpen: boolean;
  previewOpen: boolean;
  showWorkspaceToggle?: boolean;
  onSelectTab: (path: string) => void;
  onClosePreview: () => void;
  onToggleRight: () => void;
}

const isCode = (name: string) => /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|swift|c|cc|cpp|h|hpp|cs|vue|svelte|sh|sql|css|scss|html)$/i.test(name);
const isText = (name: string) => /\.(md|txt|json|ya?ml|toml|ini|conf|lock|xml|csv|log)$/i.test(name);

export function TopBar({ title, tabs, activePath, rightOpen, previewOpen, showWorkspaceToggle = true, onSelectTab, onClosePreview, onToggleRight }: TopBarProps) {
  return <header className="topbar" aria-label="全局导航">
    <div className="topbar-left" aria-hidden="true" />
    <div className="topbar-title" title={title}>{title}</div>
    <div className="topbar-tabs">
      {rightOpen && previewOpen && tabs.map((tab) => {
        const Icon = isCode(tab.name) ? FileCode2 : isText(tab.name) ? FileText : FileText;
        return <button key={tab.path} className={'topbar-tab ' + (activePath === tab.path ? 'is-active' : '')} title={tab.path} onClick={() => onSelectTab(tab.path)}>
          <Icon size={12} strokeWidth={1.7} />
          <span>{tab.name}</span>
        </button>;
      })}
      {rightOpen && previewOpen && <button className="topbar-panel-toggle" title="关闭文件预览" aria-label="关闭文件预览" onClick={onClosePreview}><X size={15} strokeWidth={1.7} /></button>}
      {showWorkspaceToggle && <button className="topbar-panel-toggle" title={rightOpen ? '收起工作区文件' : '展开工作区文件'} aria-label={rightOpen ? '收起工作区文件' : '展开工作区文件'} aria-pressed={rightOpen} onClick={onToggleRight}><PanelRight size={16} strokeWidth={1.7} /></button>}
    </div>
  </header>;
}
