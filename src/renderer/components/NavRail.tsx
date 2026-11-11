import React from 'react';
import { Button, Tooltip } from 'antd';
import { Activity, ListTree, MessageSquare, PanelLeft, Settings } from 'lucide-react';

export type AppView = 'workspace' | 'monitoring' | 'runs';

interface NavRailProps {
  view: AppView;
  onView: (view: AppView) => void;
  onSettings: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function NavRail({ view, onView, onSettings, sidebarOpen, onToggleSidebar }: NavRailProps) {
  const navButton = (label: string, icon: React.ReactNode, onClick: () => void, active = false, className = '') => (
    <Tooltip title={label} placement="right">
      <Button
        type="text"
        className={`nav-rail-button ${active ? 'is-active' : ''} ${className}`.trim()}
        aria-label={label}
        aria-pressed={active}
        icon={icon}
        onClick={onClick}
      />
    </Tooltip>
  );

  return <nav className="nav-rail" aria-label="主导航">
    {view === 'runs' ? <span className="nav-rail-placeholder" aria-hidden="true" /> : navButton(sidebarOpen ? '收起会话列表' : '展开会话列表', <PanelLeft size={17} strokeWidth={1.7} />, onToggleSidebar, sidebarOpen, 'nav-rail-toggle')}
    {navButton('工作台', <MessageSquare size={18} strokeWidth={1.7} />, () => onView('workspace'), view === 'workspace')}
    {navButton('运行监测', <Activity size={18} strokeWidth={1.7} />, () => onView('monitoring'), view === 'monitoring')}
    {navButton('运行记录', <ListTree size={18} strokeWidth={1.7} />, () => onView('runs'), view === 'runs')}
    <span className="nav-rail-spacer" />
    {navButton('设置', <Settings size={18} strokeWidth={1.7} />, onSettings, false, 'nav-rail-settings')}
  </nav>;
}
