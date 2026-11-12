import { useEffect, useRef, useState } from 'react';
import type { AppView } from '../components/NavRail';
import type { OpenFileTab } from '../components/TopBar';
import type { ProjectInfo, ProjectRecord } from '../types';
import { errorMessage } from '../format';
import { mostRecentSession, starterSession, type Session } from './sessionState';
import type { SessionRun } from './useSessionRun';

/** Coordinates the selected conversation with serialized main-process project changes. */
export function useWorkspace(run: SessionRun, showSettings: boolean, otherDialogOpen: boolean) {
  const {
    sessionsRef, setSessions, deletedSessionIdsRef, pendingSessionSavesRef,
    currentSessionId, currentSessionIdRef, setCurrentSessionId, currentSession,
    persistSession, editingMessageId, cancelMessageEdit, runningSessionId,
    cancelRequestedRef, setSessionError, setProjectReloadKey,
  } = run;
  const projectSessionIdsRef = useRef(new Map<string, string>());
  const [showNewProject, setShowNewProject] = useState(false);
  const [view, setView] = useState<AppView>('workspace');
  const [openFiles, setOpenFiles] = useState<OpenFileTab[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string>();
  const [projectList, setProjectList] = useState<ProjectRecord[]>([]);
  const projectListRequestIdRef = useRef(0);
  const [currentProject, setCurrentProject] = useState<ProjectInfo>();
  const currentProjectRef = useRef<ProjectInfo | undefined>(undefined);
  const projectRequestIdRef = useRef(0);
  const pendingProjectSelectionRef = useRef<{ requestId: number; projectId?: string; sessionId: string | null } | undefined>(undefined);
  const projectQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [projectError, setProjectError] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [approvalMode, setApprovalMode] = useState<'ask' | 'auto' | 'full'>('ask');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 760);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [isMacOS] = useState(() => navigator.userAgent.toLowerCase().includes('mac'));
  const workspaceContentRef = useRef<HTMLDivElement | null>(null);
  // Sticky-follow: stay pinned to the newest output until the user scrolls up.
  const followOutputRef = useRef(true);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (window.innerWidth < 1180) setProjectDrawerOpen(false);
      if (window.innerWidth < 760) setSidebarOpen(false);
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, []);

  useEffect(() => {
    const content = workspaceContentRef.current;
    if (!content) return;
    const onScroll = () => {
      followOutputRef.current = content.scrollHeight - content.scrollTop - content.clientHeight < 80;
    };
    content.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => content.removeEventListener('scroll', onScroll);
  }, [view, currentSessionId]);
  // Opening a session or coming back from Run History always starts at the newest output.
  useEffect(() => { followOutputRef.current = true; }, [view, currentSessionId]);
  useEffect(() => {
    const content = workspaceContentRef.current;
    if (content && followOutputRef.current) content.scrollTop = content.scrollHeight;
  }, [view, currentSessionId, currentSession?.messages]);
  useEffect(() => {
    if (currentSession?.projectId) projectSessionIdsRef.current.set(currentSession.projectId, currentSession.id);
  }, [currentSessionId, currentSession?.projectId]);


  const refreshProjects = async () => {
    const requestId = ++projectListRequestIdRef.current;
    try {
      const projects = await window.amd?.projects.list() ?? [];
      if (requestId === projectListRequestIdRef.current) setProjectList(projects);
    } catch (cause) {
      if (requestId === projectListRequestIdRef.current) setProjectError(errorMessage(cause));
    }
  };
  useEffect(() => {
    void refreshProjects();
  }, []);
  useEffect(() => {
    void window.amd?.preferences?.get().then((value) => setApprovalMode(value.approvalMode)).catch(() => undefined);
  }, [showSettings]);
  const applyProject = (project: ProjectInfo | undefined) => { currentProjectRef.current = project; setCurrentProject(project); setProjectReloadKey((key) => key + 1); setProjectError(null); setOpenFiles([]); setActiveFilePath(undefined); };
  const queueProjectOperation = <T,>(operation: () => Promise<T>): Promise<T> => {
    const pending = projectQueueRef.current.then(operation, operation);
    projectQueueRef.current = pending.catch(() => undefined);
    return pending;
  };
  const bindSessionProject = (sessionId: string | null, project: Pick<ProjectRecord, 'id' | 'root'>) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (!session || deletedSessionIdsRef.current.has(session.id)) return;
    const patch: Partial<Session> = { projectId: project.id, projectRoot: project.root, updatedAt: new Date() };
    setSessions((existing) => existing.map((candidate) => candidate.id === session.id ? { ...candidate, ...patch } : candidate));
    persistSession({ ...session, ...patch });
  };
  const selectProject = (id: string | undefined, sessionId: string | null, reveal = false) => {
    const requestId = ++projectRequestIdRef.current;
    pendingProjectSelectionRef.current = { requestId, projectId: id, sessionId };
    applyProject(undefined);
    return queueProjectOperation(async () => {
      const isCurrent = () => requestId === projectRequestIdRef.current && sessionId === currentSessionIdRef.current;
      try {
        if (!isCurrent() || !window.amd) return;
        // Serialize mutations of the main-process selection. A late open must
        // finish before the next session clears or replaces that selection.
        await window.amd.project.clear();
        if (!isCurrent()) return;
        const project = id ? await window.amd.projects.open(id) : undefined;
        if (!isCurrent()) return;
        applyProject(project);
        if (reveal) { setView('workspace'); setProjectDrawerOpen(true); }
        void refreshProjects();
      } catch (cause) {
        await window.amd?.project.clear().catch(() => undefined);
        if (!isCurrent()) return;
        applyProject(undefined);
        const message = errorMessage(cause);
        setProjectError(message.includes('不存在') ? `${message}，可将其从列表移除` : message);
      } finally {
        if (pendingProjectSelectionRef.current?.requestId === requestId) pendingProjectSelectionRef.current = undefined;
      }
    });
  };
  const openProject = (id: string) => {
    const project = projectList.find((candidate) => candidate.id === id);
    if (!project) return;
    // Entering a project navigates to its own conversation. Only the composer
    // may explicitly move a conversation (and its history) to another project.
    const candidates = sessionsRef.current.filter((session) => session.projectId === id);
    const rememberedId = projectSessionIdsRef.current.get(id);
    const session = candidates.find((candidate) => candidate.id === currentSessionIdRef.current)
      ?? candidates.find((candidate) => candidate.id === rememberedId)
      ?? mostRecentSession(candidates);
    const selected = session ?? startSession(project);
    if (session) selectSession(session.id);
    return selectProject(id, selected.id, true);
  };
  const associateProject = (id: string) => {
    const project = projectList.find((candidate) => candidate.id === id);
    if (!project) return;
    const sessionId = currentSessionIdRef.current;
    // Commit the explicit choice before loading files: sending a prompt or
    // navigating away during a slow open must retain the chosen association.
    bindSessionProject(sessionId, project);
    return selectProject(id, sessionId);
  };
  const removeProject = async (id: string) => {
    try {
      await queueProjectOperation(async () => window.amd?.projects.remove(id));
      const affected = sessionsRef.current.filter((session) => session.projectId === id);
      projectSessionIdsRef.current.delete(id);
      setSessions((existing) => existing.map((session) => session.projectId === id ? { ...session, projectId: undefined, projectRoot: undefined } : session));
      for (const session of affected) persistSession({ ...session, projectId: undefined, projectRoot: undefined, updatedAt: new Date() });
      if (currentProjectRef.current?.id === id) applyProject(undefined);
      setProjectError(null);
      void refreshProjects();
    } catch (cause) { setProjectError(errorMessage(cause)); }
  };
  const handleProjectCreated = (project: ProjectInfo) => {
    if (!project.id) throw new Error('新建项目未返回有效的项目 ID');
    setShowNewProject(false);
    const session = startSession(project, true);
    void selectProject(project.id, session.id, true);
  };
  const initGit = async () => {
    if (!window.amd || !currentProject) return;
    const requestId = projectRequestIdRef.current;
    setGitBusy(true); setProjectError(null);
    try {
      const project = await queueProjectOperation(async () => requestId === projectRequestIdRef.current ? window.amd!.project.initGit() : undefined);
      if (!project || requestId !== projectRequestIdRef.current) return;
      currentProjectRef.current = project;
      setCurrentProject(project);
      setProjectReloadKey((key) => key + 1);
      await refreshProjects();
    } catch (cause) { setProjectError(errorMessage(cause)); }
    finally { setGitBusy(false); }
  };
  useEffect(() => {
    const pending = pendingProjectSelectionRef.current;
    if (pending && pending.sessionId === currentSessionId && pending.projectId === currentSession?.projectId) return;
    if (!pending && currentSession?.projectId && currentProjectRef.current?.id === currentSession.projectId) return;
    void selectProject(currentSession?.projectId, currentSessionId);
  }, [currentSessionId, currentSession?.projectId]);

  const openFile = (path: string) => {
    setOpenFiles((current) => current.some((file) => file.path === path) ? current : [...current, { path, name: path.split('/').pop() || path }]);
    setActiveFilePath(path);
    setProjectDrawerOpen(true);
  };
  const selectSession = (id: string) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === id);
    if (!session) return;
    if (editingMessageId) cancelMessageEdit();
    if (session.projectId) projectSessionIdsRef.current.set(session.projectId, session.id);
    currentSessionIdRef.current = id;
    setCurrentSessionId(id);
    setView('workspace');
  };
  const startSession = (project?: { id?: string; root?: string }, reveal = false): Session => {
    if (editingMessageId) cancelMessageEdit();
    const session: Session = { ...starterSession(), projectId: project?.id, projectRoot: project?.root };
    setSessions((existing) => [session, ...existing]);
    if (session.projectId) projectSessionIdsRef.current.set(session.projectId, session.id);
    currentSessionIdRef.current = session.id;
    setCurrentSessionId(session.id);
    setView('workspace');
    setProjectDrawerOpen(reveal);
    setOpenFiles([]);
    setActiveFilePath(undefined);
    setSessionError(null);
    persistSession({ ...session, updatedAt: new Date() });
    return session;
  };
  const newSession = () => {
    startSession({ id: currentSession?.projectId ?? currentProject?.id, root: currentSession?.projectRoot ?? currentProject?.root });
  };
  const deleteSession = async (id: string) => {
    const deleted = sessionsRef.current.find((session) => session.id === id);
    const wasCurrent = currentSessionIdRef.current === id;
    deletedSessionIdsRef.current.add(id);
    if (editingMessageId && currentSessionId === id) cancelMessageEdit();
    const remaining = sessionsRef.current.filter((session) => session.id !== id);
    setSessions(remaining);
    if (wasCurrent) {
      const next = mostRecentSession(remaining.filter((session) => session.projectId === deleted?.projectId));
      if (next) selectSession(next.id);
      else if (deleted?.projectId) startSession({ id: deleted.projectId, root: deleted.projectRoot ?? currentProjectRef.current?.root });
      else { currentSessionIdRef.current = null; setCurrentSessionId(null); }
    }
    const replacementSessionId = currentSessionIdRef.current;
    if (runningSessionId === id) {
      cancelRequestedRef.current = true;
      void window.amd?.sessions.cancel(id).catch(() => undefined);
    }
    // A save already sent over IPC may finish after the user clicks delete.
    // Drain those writes first so deletion is always the final storage action.
    try {
      await Promise.allSettled([...(pendingSessionSavesRef.current.get(id) ?? [])]);
      await window.amd?.sessions.delete(id);
    } catch (cause) {
      deletedSessionIdsRef.current.delete(id);
      if (deleted) setSessions((existing) => existing.some((session) => session.id === id) ? existing : [deleted, ...existing]);
      if (deleted && wasCurrent && currentSessionIdRef.current === replacementSessionId) selectSession(id);
      setSessionError({ sessionId: id, message: `会话删除失败：${errorMessage(cause)}` });
    }
  };
  // ⌘N / ⌘K (Ctrl on Windows/Linux) as shown in the sidebar; disabled while a dialog is open.
  const newSessionRef = useRef(newSession);
  newSessionRef.current = newSession;
  const modalOpen = showSettings || showNewProject || otherDialogOpen;
  useEffect(() => {
    if (modalOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(isMacOS ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n') { event.preventDefault(); newSessionRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen, isMacOS]);

  const previewOpen = Boolean(activeFilePath) && view === 'workspace';
  const closePreview = () => { setActiveFilePath(undefined); setOpenFiles([]); };
  const toggleWorkspacePanel = () => {
    if (view !== 'workspace') setView('workspace');
    setProjectDrawerOpen((open) => {
      if (open) { setActiveFilePath(undefined); setOpenFiles([]); }
      return !open;
    });
  };

  return {
    view, setView, openFiles, setOpenFiles, activeFilePath, setActiveFilePath,
    showNewProject, setShowNewProject, projectList, currentProject, projectError,
    gitBusy, approvalMode, sidebarOpen, setSidebarOpen, projectDrawerOpen,
    setProjectDrawerOpen, isMacOS, workspaceContentRef, openProject, associateProject,
    removeProject, handleProjectCreated, initGit, openFile, selectSession, newSession,
    deleteSession, previewOpen, closePreview, toggleWorkspacePanel,
  };
}
