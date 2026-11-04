import React from 'react';
import { Activity, MessageSquare, PanelLeft, Settings } from 'lucide-react';

export type AppView = 'workspace' | 'monitoring';

interface NavRailProps {
  view: AppView;
  onView: (view: AppView) => void;
  onSettings: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function NavRail({ view, onView, onSettings, sidebarOpen, onToggleSidebar }: NavRailProps) {
  return <nav className="nav-rail" aria-label="主导航">
    <button className="nav-rail-button nav-rail-toggle" title={sidebarOpen ? '收起会话列表' : '展开会话列表'} aria-label={sidebarOpen ? '收起会话列表' : '展开会话列表'} aria-pressed={sidebarOpen} onClick={onToggleSidebar}><PanelLeft size={17} strokeWidth={1.7} /></button>
    <button className={'nav-rail-button ' + (view === 'workspace' ? 'is-active' : '')} title="工作台" aria-label="工作台" aria-pressed={view === 'workspace'} onClick={() => onView('workspace')}><MessageSquare size={18} strokeWidth={1.7} /></button>
    <button className={'nav-rail-button ' + (view === 'monitoring' ? 'is-active' : '')} title="运行监测" aria-label="运行监测" aria-pressed={view === 'monitoring'} onClick={() => onView('monitoring')}><Activity size={18} strokeWidth={1.7} /></button>
    <span className="nav-rail-spacer" />
    <button className="nav-rail-button nav-rail-settings" title="设置" aria-label="设置" onClick={onSettings}><Settings size={18} strokeWidth={1.7} /></button>
  </nav>;
}
