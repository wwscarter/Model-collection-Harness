import React, { useMemo, useRef, useState } from 'react';
import { Bell, ChevronRight, Folder, Plus, Search, Sparkles, X } from 'lucide-react';
import type { ProjectRecord } from '../types';

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt?: Date;
}

interface SidebarProps {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  runningSessionId: string | null;
  projects: ProjectRecord[];
  activeProjectId?: string;
  projectError?: string | null;
  completionNotice?: boolean;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onClearCompletion?: () => void;
  onNewProject: () => void;
  onOpenProject: (id: string) => void;
  onRemoveProject: (id: string) => void;
}

export function Sidebar({ sessions, currentSessionId, runningSessionId, projects, activeProjectId, projectError, completionNotice, onNewSession, onSelectSession, onDeleteSession, onClearCompletion, onNewProject, onOpenProject, onRemoveProject }: SidebarProps) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => sessions.filter((session) => session.title.toLowerCase().includes(query.toLowerCase())), [sessions, query]);
  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  const closeSearch = () => { setSearchOpen(false); setQuery(''); };
  return (
    <aside className="sidebar">
      <div className="sidebar-brandbar">
        <div className="sidebar-wordmark"><Sparkles size={14} strokeWidth={1.8} /><span>NewAI</span></div>
        <div className="sidebar-brand-actions">
          <button className="sidebar-brand-button" title="会话完成提醒" aria-label="会话完成提醒" onClick={() => onClearCompletion?.()}><Bell size={15} strokeWidth={1.7} />{completionNotice && <i className="brand-notice-dot" />}</button>
          <button className="sidebar-brand-button" title="搜索会话" aria-label="搜索会话" aria-expanded={searchOpen} onClick={() => searchOpen ? closeSearch() : openSearch()}><Search size={15} strokeWidth={1.7} /></button>
        </div>
      </div>
      {searchOpen && <div className="sidebar-search-inline"><Search size={13} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" aria-label="搜索会话" /><button className="sidebar-search-close" aria-label="关闭搜索" onClick={closeSearch}><X size={12} /></button></div>}
      <div className="sidebar-actions">
        <button className="new-session" onClick={onNewSession}><Plus size={14} /><span>新建会话</span></button>
      </div>
      <div className="sidebar-groups">
        <section className="sidebar-group" aria-label="本地项目">
          <div className="group-header">
            <button className="group-toggle" aria-expanded={projectsOpen} onClick={() => setProjectsOpen((open) => !open)}><ChevronRight size={12} className={projectsOpen ? 'open' : ''} /><span>本地项目</span><span className="count-pill">{projects.length}</span></button>
            <button className="group-action" title="新建项目" onClick={onNewProject}><Plus size={12} />新建</button>
          </div>
          {projectsOpen && <div className="group-list">
            {projects.length === 0 && <button className="empty-side-action" onClick={onNewProject}>绑定一个本地文件夹</button>}
            {projects.map((project) => {
              const active = project.id === activeProjectId;
              return <div key={project.id} className={'project-item ' + (active ? 'active' : '')}>
                <button className="item-main" title={project.displayRoot} aria-label={project.name + '，' + project.displayRoot} aria-current={active ? 'true' : undefined} onClick={() => onOpenProject(project.id)}>
                  <span className="project-icon"><Folder size={12} strokeWidth={1.7} /></span>
                  <span className="item-copy"><span className="item-title"><span className="item-title-text" title={project.name}>{project.name}</span></span></span>
                </button>
                <button className="item-remove" title="从列表移除（不会删除文件）" aria-label={'从列表移除 ' + project.name} onClick={() => onRemoveProject(project.id)}><X size={13} /></button>
              </div>;
            })}
            {projectError && <div className="sidebar-error" role="alert">{projectError}</div>}
          </div>}
        </section>
        <section className="sidebar-group" aria-label="最近会话">
          <div className="group-header"><button className="group-toggle" aria-expanded={sessionsOpen} onClick={() => setSessionsOpen((open) => !open)}><ChevronRight size={12} className={sessionsOpen ? 'open' : ''} /><span>最近会话</span><span className="count-pill">{sessions.length}</span></button></div>
          {sessionsOpen && <div className="group-list">
            {filtered.length === 0 && <div className="empty-side">还没有匹配的会话</div>}
            {filtered.map((session) => {
              const active = session.id === currentSessionId;
              const running = session.id === runningSessionId;
              return <div key={session.id} className={'session-item ' + (active ? 'active' : '')}>
                <button className="item-main" aria-current={active ? 'true' : undefined} onClick={() => onSelectSession(session.id)}>
                  <span className={'session-ring ' + (active || running ? 'on' : '')} />
                  <span className="item-copy"><span className="item-title"><span className="item-title-text" title={session.title || '未命名会话'}>{session.title || '未命名会话'}</span></span></span>
                  {running && <span className="status-chip">进行中</span>}
                </button>
                <button className="item-remove" title="删除会话" aria-label="删除会话" onClick={() => onDeleteSession(session.id)}><X size={13} /></button>
              </div>;
            })}
          </div>}
        </section>
      </div>
    </aside>
  );
}
