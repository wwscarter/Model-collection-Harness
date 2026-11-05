import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, ChevronRight, Folder, Plus, Search, Sparkles, X } from 'lucide-react';
import type { ProjectRecord } from '../types';

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt?: Date;
  projectId?: string;
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
  const sessionProjectId = sessions.find((session) => session.id === currentSessionId)?.projectId;
  const selectedSessionProjectId = projects.some((project) => project.id === sessionProjectId) ? sessionProjectId : undefined;
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set([activeProjectId, selectedSessionProjectId].filter((id): id is string => Boolean(id))));
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = Boolean(query.trim());
  const { projectSessions, recentSessions } = useMemo(() => {
    const grouped = new Map(projects.map((project) => [project.id, [] as SessionSummary[]]));
    const recent: SessionSummary[] = [];
    const normalizedQuery = query.trim().toLowerCase();
    for (const session of sessions) {
      if (!(session.title || '未命名会话').toLowerCase().includes(normalizedQuery)) continue;
      const group = session.projectId ? grouped.get(session.projectId) : undefined;
      // Keep sessions reachable when their project is no longer registered.
      if (group) group.push(session);
      else recent.push(session);
    }
    return { projectSessions: grouped, recentSessions: recent };
  }, [sessions, projects, query]);
  const visibleProjects = searching ? projects.filter((project) => projectSessions.get(project.id)?.length) : projects;
  useEffect(() => {
    const ids = [activeProjectId, selectedSessionProjectId].filter((id): id is string => Boolean(id));
    if (ids.length) {
      setProjectsOpen(true);
      setExpandedProjects((existing) => new Set([...existing, ...ids]));
    }
    if (currentSessionId && !selectedSessionProjectId) setSessionsOpen(true);
  }, [activeProjectId, selectedSessionProjectId, currentSessionId]);
  const toggleProject = (id: string) => setExpandedProjects((existing) => {
    const next = new Set(existing);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const openProject = (id: string) => {
    setExpandedProjects((existing) => new Set([...existing, id]));
    onOpenProject(id);
  };
  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  const closeSearch = () => { setSearchOpen(false); setQuery(''); };
  const renderSession = (session: SessionSummary) => {
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
  };
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
            <button className="group-toggle" aria-expanded={projectsOpen || searching} onClick={() => setProjectsOpen((open) => !open)}><ChevronRight size={12} className={projectsOpen || searching ? 'open' : ''} /><span>本地项目</span></button>
            <button className="group-action" title="新建项目" onClick={onNewProject}><Plus size={12} />新建</button>
          </div>
          {(projectsOpen || searching) && <div className="group-list">
            {projects.length === 0 && <button className="empty-side-action" onClick={onNewProject}>绑定一个本地文件夹</button>}
            {visibleProjects.map((project) => {
              const active = project.id === activeProjectId;
              const expanded = searching || expandedProjects.has(project.id);
              const children = projectSessions.get(project.id) ?? [];
              const childrenId = `project-sessions-${project.id}`;
              return <div key={project.id} className="project-branch" data-project-id={project.id}>
                <div className={'project-item ' + (active ? 'active' : '')}>
                  <button className="project-expand" aria-label={`${expanded ? '收起' : '展开'} ${project.name}的会话`} aria-expanded={expanded} aria-controls={childrenId} onClick={() => toggleProject(project.id)}><ChevronRight size={12} className={expanded ? 'open' : ''} /></button>
                  <button className="item-main" title={project.displayRoot} aria-label={project.name + '，' + project.displayRoot} aria-current={active ? 'true' : undefined} aria-expanded={expanded} aria-controls={childrenId} onClick={() => openProject(project.id)}>
                    <span className="project-icon"><Folder size={12} strokeWidth={1.7} /></span>
                    <span className="item-copy"><span className="item-title"><span className="item-title-text" title={project.name}>{project.name}</span></span></span>
                    {!expanded && children.some((session) => session.id === runningSessionId) && <span className="status-chip">进行中</span>}
                  </button>
                  <button className="item-remove" title="从列表移除（不会删除文件）" aria-label={'从列表移除 ' + project.name} onClick={() => onRemoveProject(project.id)}><X size={13} /></button>
                </div>
                {expanded && <div id={childrenId} className="project-sessions" role="group" aria-label={project.name + '的会话'}>
                  {children.length ? children.map(renderSession) : <div className="project-sessions-empty">暂无会话</div>}
                </div>}
              </div>;
            })}
            {projectError && <div className="sidebar-error" role="alert">{projectError}</div>}
          </div>}
        </section>
        <section className="sidebar-group" aria-label="最近会话">
          <div className="group-header"><button className="group-toggle" aria-expanded={sessionsOpen || searching} onClick={() => setSessionsOpen((open) => !open)}><ChevronRight size={12} className={sessionsOpen || searching ? 'open' : ''} /><span>最近会话</span></button></div>
          {(sessionsOpen || searching) && <div className="group-list">
            {recentSessions.length === 0 && <div className="empty-side">{searching ? '没有匹配的独立会话' : '暂无独立会话'}</div>}
            {recentSessions.map(renderSession)}
          </div>}
        </section>
      </div>
    </aside>
  );
}
