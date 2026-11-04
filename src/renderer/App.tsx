import React, { useEffect, useRef, useState } from 'react';
import { Sidebar, SessionSummary } from './components/Sidebar';
import { Settings } from './pages/Settings';
import { NavRail, type AppView } from './components/NavRail';
import { MonitoringPage } from './pages/MonitoringPage';
import { RoutingPanel } from './components/RoutingPanel';
import { WorkspacePanel } from './components/WorkspacePanel';
import { TopBar, type OpenFileTab } from './components/TopBar';
import { NewProjectDialog } from './components/NewProjectDialog';
import { AgentInputBar } from './components/AgentInputBar';
import { WorkbenchWelcome } from './components/WorkbenchWelcome';
import { OutputView } from './components/OutputView';
import { ToolCallList } from './components/ToolCallList';
import { ModelConfig, ProjectInfo, ProjectRecord, RunTrace, SessionMetrics } from './types';
import { appendAssistantChunk, ChatAgentMessage, ChatMessage, historyForModel, preparePendingTurn, restoreMessages, setLatestAssistantDuration, settleAssistantTools, stripAssistantProcess, ToolCallUpdate, updateAssistantAgent, updateLatestAssistantAttribution, updateLatestAssistantContent, upsertAssistantTool } from './sessionMessages';
import { Copy, Pencil, UsersRound } from 'lucide-react';
import { shouldSubmitPromptKey } from './promptKeyboard';
import { errorMessage } from './format';
import { completeSessionMetrics, restoreRouteConfidence, type SessionRunTiming } from './sessionMetrics';

interface Session extends SessionSummary { prompt: string; userMessage?: string; output: string; messages: ChatMessage[]; modelUsed?: string; runId?: string; routeConfidence?: number; metrics?: SessionMetrics; audit?: { passed: boolean; score: number; issueCount: number }; auditResult?: { passed: boolean; score: number; issueCount: number }; taskType?: string; rating?: number; multiModel?: boolean; modelId?: string; projectId?: string; projectRoot?: string; updatedAt?: Date; }

const starterSession = (): Session => ({ id: `session-${Date.now()}`, title: '新的工作会话', prompt: '', userMessage: '', output: '', messages: [], multiModel: true, createdAt: new Date() });
const formatDuration = (value?: number) => value === undefined || !Number.isFinite(value) ? undefined : value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(1) + ' s';

export default function App() {
  const [sessions, setSessionsState] = useState<Session[]>([starterSession()]);
  // IPC events can arrive immediately before execute rejects. Keep their latest
  // state available synchronously so a failed/cancelled turn is saved in full.
  const sessionsRef = useRef(sessions);
  const setSessions = (update: React.SetStateAction<Session[]>) => {
    const next = typeof update === 'function' ? update(sessionsRef.current) : update;
    sessionsRef.current = next;
    setSessionsState(next);
  };
  const cancelRequestedRef = useRef(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showRouting, setShowRouting] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [view, setView] = useState<AppView>('workspace');
  const [openFiles, setOpenFiles] = useState<OpenFileTab[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string>();
  const [completionNotice, setCompletionNotice] = useState(false);
  const [projectList, setProjectList] = useState<ProjectRecord[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectInfo>();
  const [projectError, setProjectError] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [approvalMode, setApprovalMode] = useState<'ask' | 'auto' | 'full'>('ask');
  const [projectReloadKey, setProjectReloadKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 760);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [isMacOS] = useState(() => navigator.userAgent.toLowerCase().includes('mac'));
  const [liveTrace, setLiveTrace] = useState<RunTrace>();
  const currentRunIdRef = useRef<string | undefined>(undefined);
  const [sessionError, setSessionError] = useState<{ sessionId: string; message: string } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const includeProjectContext = true;
  const workspaceContentRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const promptBeforeEditingRef = useRef('');
  const runTimingRef = useRef<SessionRunTiming | null>(null);
  const [liveElapsedMs, setLiveElapsedMs] = useState(0);
  const currentSession = sessions.find((session) => session.id === currentSessionId) || null;
  // Only one task runs at a time; track which session owns it so other sessions don't show its spinner or error.
  const isLoading = runningSessionId !== null;
  const isCurrentRunning = isLoading && runningSessionId === currentSessionId;
  const error = sessionError?.sessionId === currentSessionId ? sessionError.message : null;
  const modelLabel = (id?: string) => {
    if (!id) return undefined;
    const model = models.find((candidate) => candidate.id === id || candidate.name === id || candidate.modelId === id);
    return model ? model.modelId || model.name : id;
  };
  const latestAssistant = currentSession?.messages.slice().reverse().find((message) => message.role === 'assistant');
  const bannerModels = [modelLabel(latestAssistant?.planningModelId), modelLabel(latestAssistant?.modelUsed ?? currentSession?.modelUsed)].filter(Boolean).join(' + ') || '自动调度';
  const withRunTiming = (metrics: SessionMetrics | undefined, sessionId: string, confidence: number | undefined, hasOutput: boolean): SessionMetrics | undefined => {
    const timing = runTimingRef.current;
    return completeSessionMetrics(metrics, timing?.sessionId === sessionId ? timing : undefined, confidence, hasOutput, performance.now());
  };

  useEffect(() => {
    if (!runningSessionId) return;
    const updateElapsed = () => {
      const timing = runTimingRef.current;
      if (timing?.sessionId === runningSessionId) setLiveElapsedMs(performance.now() - timing.startedAt);
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [runningSessionId]);

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
    // Only follow the stream while the user is already near the bottom; otherwise
    // reading earlier output is impossible because every chunk steals focus.
    const distance = content.scrollHeight - content.scrollTop - content.clientHeight;
    if (distance < 120) content.scrollTop = content.scrollHeight;
  }, [currentSessionId, currentSession?.messages]);

  useEffect(() => {
    setEditingMessageId(null);
    promptBeforeEditingRef.current = '';
    setLiveTrace(undefined);
  }, [currentSessionId]);

  useEffect(() => {
    // 预加载模型列表，避免第一次执行时的延迟
    const loadModels = async () => {
      try {
        const modelList = await window.amd?.models.list();
        if (modelList) setModels(modelList);
      } catch (error) {
        console.error('Failed to load models:', error);
      }
    };
    loadModels();
    if (!window.amd) setCurrentSessionId(sessions[0]?.id || null);

    void window.amd?.sessions.list().then((records) => {
      const restored = records.map((record) => ({
        id: String(record.id), title: String(record.title || '未命名会话'), prompt: String(record.prompt || ''), userMessage: String(record.userMessage || ''), output: String(record.output || ''), messages: restoreMessages(record),
        modelUsed: record.modelUsed ? String(record.modelUsed) : undefined, runId: record.runId ? String(record.runId) : undefined, metrics: record.metrics as SessionMetrics | undefined,
        audit: record.auditResult as Session['audit'], auditResult: record.auditResult as Session['auditResult'],
        routeConfidence: restoreRouteConfidence(record),
        multiModel: record.multiModel !== false, modelId: record.modelId ? String(record.modelId) : undefined,
        projectId: record.projectId ? String(record.projectId) : undefined, projectRoot: record.projectRoot ? String(record.projectRoot) : undefined,
        rating: typeof record.rating === 'number' ? record.rating : undefined,
        createdAt: new Date(String(record.createdAt)), updatedAt: new Date(String(record.updatedAt || record.createdAt)),
      }));
      if (restored.length) { setSessions(restored); setCurrentSessionId(restored[0].id); }
      else setCurrentSessionId(sessions[0]?.id || null);
    }).catch(() => setCurrentSessionId(sessions[0]?.id || null));
    const unsubscribeChunk = window.amd?.on('session:chunk', (payload) => {
      const event = payload as { sessionId?: string; taskId?: string; delta?: string };
      const id = event.sessionId || event.taskId;
      if (!id || !event.delta) return;
      const timing = runTimingRef.current;
      // The full output may beat queued stream events over IPC; do not append it twice.
      if (timing?.sessionId === id && timing.completedAt !== undefined) return;
      if (timing?.sessionId === id && timing.ttftMs === undefined) timing.ttftMs = performance.now() - timing.startedAt;
      setSessions((existing) => existing.map((session) => {
        if (session.id !== id) return session;
        const messages = appendAssistantChunk(session.messages, event.delta!);
        return { ...session, messages, output: messages.slice().reverse().find((message) => message.role === 'assistant')?.content || '' };
      }));
    });
    const unsubscribeModel = window.amd?.on('session:model-switched', (payload) => {
      const event = payload as { sessionId?: string; taskId?: string; modelId?: string; role?: 'routing' | 'planning' | 'execution' | 'orchestrator'; planningModelId?: string; confidence?: number };
      const id = event.sessionId || event.taskId;
      if (!id || !event.modelId) return;
      const timing = runTimingRef.current;
      if (timing?.sessionId === id && event.confidence !== undefined) timing.routeConfidence = event.confidence;
      setSessions((existing) => existing.map((session) => {
        if (session.id !== id) return session;
        if (event.role === 'routing') return { ...session, routeConfidence: event.confidence };
        if (event.role === 'orchestrator') return { ...session, modelUsed: event.modelId };
        if (event.role === 'planning') return { ...session, messages: updateLatestAssistantAttribution(session.messages, { planningModelId: event.modelId }) };
        if (event.role === 'execution') return {
          ...session,
          modelUsed: event.modelId,
          routeConfidence: event.confidence,
          messages: updateLatestAssistantAttribution(session.messages, { modelUsed: event.modelId, planningModelId: event.planningModelId }),
        };
        return session;
      }));
    });
    const unsubscribeAgent = window.amd?.on('session:agent-update', (payload) => {
      const event = payload as { sessionId?: string; assistantMessageId?: string; agentId?: string; modelId?: string; modelName?: string; status?: ChatAgentMessage['status']; delta?: string; content?: string; error?: string };
      if (!event.sessionId || !event.assistantMessageId || !event.agentId) return;
      setSessions((existing) => existing.map((session) => session.id === event.sessionId ? {
        ...session,
        messages: updateAssistantAgent(session.messages, event.assistantMessageId!, {
          agentId: event.agentId!, modelId: event.modelId, modelName: event.modelName, status: event.status, delta: event.delta, content: event.content, error: event.error,
        }),
      } : session));
    });
    const unsubscribeTool = window.amd?.on('session:tool-call', (payload) => {
      const event = payload as Partial<ToolCallUpdate> & { sessionId?: string; assistantMessageId?: string; agentId?: string };
      if (event.status === 'completed' && ['write', 'edit', 'run_command'].includes(event.toolName ?? '')) setProjectReloadKey((key) => key + 1);
      // Sub-agent tool calls are folded into their own report; only the main answer shows cards.
      if (!event.sessionId || !event.assistantMessageId || event.agentId || !event.toolCallId || !event.toolName || !event.status) return;
      setSessions((existing) => existing.map((session) => session.id === event.sessionId ? {
        ...session,
        messages: upsertAssistantTool(session.messages, event.assistantMessageId!, event as ToolCallUpdate),
      } : session));
    });
    const unsubscribeTrace = window.amd?.on('session:trace', (payload) => {
      const event = payload as { type?: string; runId?: string; span?: RunTrace['spans'][number]; run?: RunTrace['run'] };
      if (!event.runId || event.runId !== currentRunIdRef.current) return;
      setLiveTrace((current) => {
        const spans = event.span
          ? [...(current?.spans.filter((span) => span.id !== event.span!.id) ?? []), event.span]
          : current?.spans ?? [];
        const run = event.run ?? current?.run ?? {
          id: event.runId!, sessionId: '', status: 'running' as const,
          startedAt: event.span?.startedAt ?? new Date().toISOString(),
          totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0,
        };
        return { run, spans };
      });
    });
    const unsubscribe = window.amd?.on('session:completed', (payload) => {
      const event = payload as { sessionId?: string; taskId?: string; runId?: string; output?: string; modelUsed?: string | { id?: string; name?: string }; planningModelId?: string; decision?: { confidence?: number }; metrics?: SessionMetrics };
      const id = event.sessionId || event.taskId;
      if (!id) return;
      const modelUsed = typeof event.modelUsed === 'string' ? event.modelUsed : event.modelUsed?.id || event.modelUsed?.name;
      const metrics = withRunTiming(event.metrics, id, event.decision?.confidence, Boolean(event.output));
      setSessions((existing) => existing.map((session) => {
        if (session.id !== id) return session;
        let messages = updateLatestAssistantContent(session.messages, event.output ?? '', modelUsed, event.planningModelId);
        if (metrics?.latencyMs !== undefined) messages = setLatestAssistantDuration(messages, metrics.latencyMs);
        return { ...session, messages, output: event.output ?? '', modelUsed, runId: event.runId ?? session.runId, routeConfidence: metrics?.routeConfidence, metrics };
      }));
      setCompletionNotice(true);
    });
    return () => { unsubscribeChunk?.(); unsubscribeModel?.(); unsubscribeAgent?.(); unsubscribeTool?.(); unsubscribeTrace?.(); unsubscribe?.(); };
  }, []);

  const refreshProjects = async () => {
    try { setProjectList(await window.amd?.projects.list() ?? []); } catch (cause) { setProjectError(errorMessage(cause)); }
  };
  useEffect(() => {
    void refreshProjects();
    void window.amd?.project.current().then(setCurrentProject).catch(() => undefined);
  }, []);
  useEffect(() => {
    void window.amd?.preferences?.get().then((value) => setApprovalMode(value.approvalMode)).catch(() => undefined);
  }, [showSettings]);
  const applyProject = (project: ProjectInfo | undefined) => { setCurrentProject(project); setProjectReloadKey((key) => key + 1); setProjectError(null); setOpenFiles([]); setActiveFilePath(undefined); void refreshProjects(); };
  const bindSessionProject = (project: ProjectInfo) => {
    if (!currentSession) return;
    const patch: Partial<Session> = { projectId: project.id, projectRoot: project.root, updatedAt: new Date() };
    updateCurrent(patch);
    void window.amd?.sessions.save({ ...currentSession, ...patch });
  };
  const openProject = async (id: string) => {
    if (!window.amd) return;
    try {
      const project = await window.amd.projects.open(id);
      applyProject(project);
      bindSessionProject(project);
      setView('workspace');
      // Clicking a project is an explicit request for its files; reveal the tree
      // so the active association is visible even though it is hidden by default.
      setProjectDrawerOpen(true);
    } catch (cause) { const message = errorMessage(cause); setProjectError(message.includes('不存在') ? `${message}，可将其从列表移除` : message); }
  };
  const associateProject = async (id: string) => {
    if (!window.amd) return;
    try { const project = await window.amd.projects.open(id); applyProject(project); bindSessionProject(project); }
    catch (cause) { setProjectError(errorMessage(cause)); }
  };
  const removeProject = async (id: string) => {
    try {
      await window.amd?.projects.remove(id);
      if (currentProject?.id === id) { setCurrentProject(undefined); setOpenFiles([]); setActiveFilePath(undefined); }
      setProjectError(null);
      void refreshProjects();
    } catch (cause) { setProjectError(errorMessage(cause)); }
  };
  const handleProjectCreated = (project: ProjectInfo) => { setShowNewProject(false); applyProject(project); bindSessionProject(project); setProjectDrawerOpen(true); };
  const initGit = async () => {
    if (!window.amd || !currentProject) return;
    setGitBusy(true); setProjectError(null);
    try {
      const project = await window.amd.project.initGit();
      setCurrentProject(project);
      setProjectReloadKey((key) => key + 1);
      await refreshProjects();
    } catch (cause) { setProjectError(errorMessage(cause)); }
    finally { setGitBusy(false); }
  };
  useEffect(() => {
    if (!currentSession) return;
    if (!currentSession.projectId) { setCurrentProject(undefined); return; }
    if (currentProject?.id === currentSession.projectId) return;
    let active = true;
    void window.amd?.projects.open(currentSession.projectId).then((project) => { if (active) applyProject(project); }).catch((cause) => { if (active) setProjectError(errorMessage(cause)); });
    return () => { active = false; };
  }, [currentSessionId]);

  const updateCurrent = (patch: Partial<Session>) => setSessions((existing) => existing.map((session) => session.id === currentSessionId ? { ...session, ...patch } : session));
  const openFile = (path: string) => {
    setOpenFiles((current) => current.some((file) => file.path === path) ? current : [...current, { path, name: path.split('/').pop() || path }]);
    setActiveFilePath(path);
    setProjectDrawerOpen(true);
  };
  const startMessageEdit = (message: ChatMessage) => {
    if (!currentSession || isLoading) return;
    promptBeforeEditingRef.current = currentSession.prompt;
    setEditingMessageId(message.id);
    updateCurrent({ prompt: message.content });
    requestAnimationFrame(() => promptInputRef.current?.focus());
  };
  const cancelMessageEdit = () => {
    if (!editingMessageId) return;
    updateCurrent({ prompt: promptBeforeEditingRef.current });
    promptBeforeEditingRef.current = '';
    setEditingMessageId(null);
  };
  const selectSession = (id: string) => { if (editingMessageId) cancelMessageEdit(); setCurrentSessionId(id); setView('workspace'); };
  const newSession = () => {
    if (editingMessageId) cancelMessageEdit();
    const session: Session = { ...starterSession(), projectId: currentProject?.id, projectRoot: currentProject?.root };
    setSessions((existing) => [session, ...existing]);
    setCurrentSessionId(session.id);
    setView('workspace');
    setProjectDrawerOpen(false);
    setOpenFiles([]);
    setActiveFilePath(undefined);
    setSessionError(null);
    void window.amd?.sessions.save({ ...session, updatedAt: new Date() });
  };
  const enabledModelOptions = models.filter((model) => model.enabled && (model.hasApiKey || model.provider === 'custom'));
  const defaultSessionModelId = enabledModelOptions.find((model) => model.isPrimary)?.id ?? enabledModelOptions[0]?.id;
  const saveSessionPreference = (patch: Partial<Session>) => {
    if (!currentSession) return;
    const next = { ...currentSession, ...patch };
    updateCurrent(patch);
    void window.amd?.sessions.save({ ...next, updatedAt: new Date() });
  };
  const toggleMultiModel = () => {
    if (!currentSession) return;
    const multiModel = currentSession.multiModel === false;
    saveSessionPreference({ multiModel, ...(multiModel ? {} : { modelId: currentSession.modelId ?? defaultSessionModelId }) });
  };
  const selectSessionModel = (modelId: string) => saveSessionPreference({ modelId, multiModel: false });
  const deleteSession = (id: string) => { if (editingMessageId && currentSessionId === id) cancelMessageEdit(); const remaining = sessions.filter((session) => session.id !== id); setSessions(remaining); if (currentSessionId === id) setCurrentSessionId(remaining[0]?.id || null); void window.amd?.sessions.delete(id); };
  const handleModelsChanged = (nextModels: ModelConfig[]) => setModels(nextModels);
  const execute = async () => {
    // Enter bypasses the disabled send button, so guard here too.
    if (!currentSession || !currentSession.prompt.trim() || isLoading) return;
    const enabledModels = models.filter((model) => model.enabled && (model.hasApiKey || model.provider === 'custom'));
    const defaultModel = enabledModels.find((model) => model.isPrimary) ?? enabledModels[0];
    const pinnedModelId = currentSession.multiModel === false ? (currentSession.modelId && enabledModels.some((model) => model.id === currentSession.modelId) ? currentSession.modelId : defaultModel?.id) : undefined;
    if (currentSession.multiModel === false && !pinnedModelId) { setSessionError({ sessionId: currentSession.id, message: '请先在设置中启用一个可用模型。' }); return; }
    const prompt = currentSession.prompt.trim();
    const runId = crypto.randomUUID();
    currentRunIdRef.current = runId;
    setLiveTrace({
      run: { id: runId, sessionId: currentSession.id, status: 'running', startedAt: new Date().toISOString(), totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 },
      spans: [],
    });
    // Keep the first title; overwriting it on every follow-up made sessions impossible to find.
    const title = currentSession.messages.length ? currentSession.title : prompt.slice(0, 36);
    const messageId = crypto.randomUUID();
    const messages = preparePendingTurn(currentSession.messages, messageId, prompt, editingMessageId ?? undefined);
    const submittedSession: Session = { ...currentSession, prompt: '', userMessage: prompt, output: '', messages, title, runId: undefined, metrics: undefined, modelUsed: undefined, routeConfidence: undefined, audit: undefined, auditResult: undefined, rating: undefined, updatedAt: new Date() };
    cancelRequestedRef.current = false;
    runTimingRef.current = { sessionId: currentSession.id, startedAt: performance.now() };
    setLiveElapsedMs(0);
    promptBeforeEditingRef.current = '';
    setEditingMessageId(null);
    setSessionError(null);
    setRunningSessionId(currentSession.id);
    setSessions((existing) => existing.map((session) => session.id === currentSession.id ? submittedSession : session));
    try {
      if (!window.amd) throw new Error('主进程尚未连接，请在 Electron 中运行应用。');
      await window.amd.sessions.save(submittedSession);
      if (cancelRequestedRef.current) throw new Error('任务已取消');
      // 流式执行，不等待完全完成 - 由事件监听器处理结果
      const result = await window.amd.sessions.execute({
        sessionId: currentSession.id,
        taskId: currentSession.id,
        runId,
        assistantMessageId: `${messageId}-assistant`,
        prompt,
        taskType: 'general',
        stream: true,
        includeProjectContext,
        pinnedModelId,
        // Earlier turns of this conversation (the pending user/assistant pair is the last two).
        history: historyForModel(messages.slice(0, -2)),
      });
      const raw = result as any;
      const modelUsed = typeof raw.modelUsed === 'string' ? raw.modelUsed : raw.modelUsed?.id || raw.modelUsed?.name;
      const output = String(raw.output || '');
      const metrics = withRunTiming(raw.metrics, currentSession.id, raw.decision?.confidence, Boolean(output));
      let completedMessages = updateLatestAssistantContent(messages, output, modelUsed, raw.planningModelId);
      const elapsedMs = metrics?.latencyMs ?? (runTimingRef.current?.sessionId === currentSession.id ? performance.now() - runTimingRef.current.startedAt : undefined);
      if (elapsedMs !== undefined) completedMessages = setLatestAssistantDuration(completedMessages, elapsedMs);
      const persistedMessages = stripAssistantProcess(completedMessages);
      const completedSession: Session = { ...submittedSession, messages: persistedMessages, output, modelUsed, runId: raw.runId ?? runId, routeConfidence: metrics?.routeConfidence, metrics, audit: raw.audit, auditResult: raw.audit, taskType: raw.decision?.taskType, updatedAt: new Date() };
      setSessions((existing) => existing.map((session) => session.id === currentSession.id ? completedSession : session));
      await window.amd.sessions.save(completedSession);
    } catch (cause) {
      setSessionError({ sessionId: currentSession.id, message: errorMessage(cause) });
      const latestSession = sessionsRef.current.find((session) => session.id === currentSession.id);
      if (latestSession) {
        const settledMessages = settleAssistantTools(latestSession.messages, `${messageId}-assistant`).map((message) => message.id !== `${messageId}-assistant` || !message.agents ? message : {
          ...message,
          agents: message.agents.map((agent) => agent.status === 'queued' || agent.status === 'running' ? { ...agent, status: 'failed' as const, error: errorMessage(cause) } : agent),
        });
        const failedSession: Session = { ...latestSession, runId, messages: stripAssistantProcess(settledMessages), updatedAt: new Date() };
        setSessions((existing) => existing.map((session) => session.id === currentSession.id ? failedSession : session));
        try { await window.amd?.sessions.save(failedSession); }
        catch (saveError) { setSessionError({ sessionId: currentSession.id, message: `${errorMessage(cause)}（会话保存失败：${errorMessage(saveError)}）` }); }
      }
    } finally {
      setRunningSessionId(null);
    }
  };
  const cancelRun = async () => {
    if (!runningSessionId) return;
    cancelRequestedRef.current = true;
    try { await window.amd?.sessions.cancel(runningSessionId); }
    catch (cause) { setSessionError({ sessionId: runningSessionId, message: errorMessage(cause) }); }
  };
  // ⌘N / ⌘K (Ctrl on Windows/Linux) as shown in the sidebar; disabled while a dialog is open.
  const newSessionRef = useRef(newSession);
  newSessionRef.current = newSession;
  const modalOpen = showSettings || showNewProject || showRouting;
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

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSubmitPromptKey(event.nativeEvent)) {
      event.preventDefault();
      void execute();
    } else if (event.key === 'Escape' && editingMessageId) {
      event.preventDefault();
      cancelMessageEdit();
    }
  };

  const previewOpen = Boolean(activeFilePath) && view === 'workspace';
  const closePreview = () => { setActiveFilePath(undefined); setOpenFiles([]); };
  const toggleWorkspacePanel = () => {
    if (view !== 'workspace') setView('workspace');
    setProjectDrawerOpen((open) => {
      if (open) { setActiveFilePath(undefined); setOpenFiles([]); }
      return !open;
    });
  };
  return <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} ${projectDrawerOpen && view === 'workspace' ? 'drawer-open' : ''} ${previewOpen && projectDrawerOpen ? 'preview-open' : ''} ${isMacOS ? 'mac-shell' : ''} ${view === 'monitoring' ? 'monitoring-shell' : ''}`}>
    <TopBar title={view === 'monitoring' ? '运行监测' : currentSession?.title || '新建会话'} tabs={openFiles} activePath={activeFilePath} rightOpen={view === 'workspace' && projectDrawerOpen} previewOpen={previewOpen} onSelectTab={setActiveFilePath} onClosePreview={closePreview} onToggleRight={toggleWorkspacePanel} />
    <NavRail view={view} onView={(next) => { setView(next); if (next === 'monitoring') { setProjectDrawerOpen(false); setActiveFilePath(undefined); setOpenFiles([]); } }} onSettings={() => setShowSettings(true)} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((open) => !open)} />
    <Sidebar sessions={sessions} currentSessionId={currentSessionId} runningSessionId={runningSessionId} projects={projectList} activeProjectId={currentProject?.id} projectError={projectError} completionNotice={completionNotice} onClearCompletion={() => setCompletionNotice(false)} onNewSession={newSession} onSelectSession={selectSession} onDeleteSession={deleteSession} onNewProject={() => setShowNewProject(true)} onOpenProject={(id) => void openProject(id)} onRemoveProject={(id) => void removeProject(id)} />
    {sidebarOpen && <button className="panel-backdrop sidebar-backdrop" aria-label="关闭导航栏" onClick={() => setSidebarOpen(false)} />}
    {view === 'monitoring' ? <MonitoringPage liveTrace={liveTrace} /> : <main className="workspace">
      <div ref={workspaceContentRef} className={`workspace-content ${currentSession && !currentSession.messages.length ? 'empty-workspace' : ''}`}>
        {currentSession ? <section className="chat-thread" aria-label="会话消息">
          {!!currentSession.messages.length && <div className="chat-model-line"><span>{bannerModels}</span></div>}
          {currentSession.messages.length ? currentSession.messages.map((message, index) => {
            const live = isCurrentRunning && index === currentSession.messages.length - 1;
            if (message.role === 'user') return <div key={message.id} className="user-message-row"><div className="user-message-bubble"><div className="user-message-text">{message.content}</div><div className="user-message-footer"><button className="message-icon-button" title="复制消息" aria-label="复制消息" onClick={() => void navigator.clipboard?.writeText(message.content)}><Copy size={14} strokeWidth={1.8} /></button><button className="message-icon-button" title="编辑消息" aria-label="编辑消息" disabled={isLoading} onClick={() => startMessageEdit(message)}><Pencil size={14} strokeWidth={1.8} /></button></div></div></div>;
            return <div key={message.id} className="assistant-turn">
              {live && !message.content && <div className="thinking-pill"><i className="live-dot pulse" />思考中 · 正在路由并选择执行模型</div>}
              <article className="assistant-card">
                <header className="assistant-card-header">
                  <span className="assistant-title"><i className={live ? 'live-dot pulse' : 'live-dot'} /><strong>{modelLabel(message.modelUsed) ?? (live ? '正在选择执行模型' : 'newAi')}</strong>{message.planningModelId && <small className="planning-attribution">规划：{modelLabel(message.planningModelId)}</small>}{formatDuration(live ? liveElapsedMs : message.durationMs) && <small className="assistant-duration">{formatDuration(live ? liveElapsedMs : message.durationMs)}</small>}</span>
                  {live ? <span className="streaming-badge mono">Streaming</span> : message.content && <button className="message-icon-button" title="复制回复" aria-label="复制回复" onClick={() => void navigator.clipboard?.writeText(message.content)}><Copy size={14} strokeWidth={1.8} /></button>}
                </header>
                {live && !!message.tools?.length && <ToolCallList tools={message.tools} />}
                <OutputView content={message.content} loading={live && Boolean(message.content)} emptyState={false} />
                {live && !!message.agents?.length && <section className="agent-board" aria-label="并行子智能体报告"><div className="agent-board-heading"><UsersRound size={15} /><strong>子智能体报告</strong><span>{message.agents.filter((agent) => agent.status === 'completed').length}/{message.agents.length} 完成</span></div>{message.agents.map((agent) => <div className="agent-report" key={agent.id}><header><strong>{agent.modelName}</strong><span className={`agent-status ${agent.status}`}>{({ queued: '等待中', running: '分析中', completed: '已完成', failed: '失败' })[agent.status]}</span></header>{agent.content ? <OutputView content={agent.content} loading={agent.status === 'running'} emptyState={false} /> : agent.status === 'running' ? <p className="agent-placeholder">正在独立分析…</p> : null}{agent.error && <div className="agent-error">{agent.error}</div>}</div>)}</section>}
                {error && index === currentSession.messages.length - 1 && <div className="error-banner">{error}</div>}
              </article>
            </div>;
          }) : <WorkbenchWelcome onChoose={(prompt) => { updateCurrent({ prompt }); promptInputRef.current?.focus(); }} onOpenProject={() => setShowNewProject(true)} />}
        </section> : <div className="no-session"><strong>创建一个会话开始工作</strong><button className="button primary" onClick={newSession}>新建会话</button></div>}
      </div>
      {currentSession && <AgentInputBar
        project={currentProject} projects={projectList} onSelectProject={(id) => void associateProject(id)} gitBusy={gitBusy} onInitGit={() => void initGit()} approvalMode={approvalMode} onOpenSettings={() => setShowSettings(true)} value={currentSession.prompt} inputRef={promptInputRef}
        hasMessages={currentSession.messages.length > 0} busy={isLoading} running={isCurrentRunning} editing={Boolean(editingMessageId)}
        onChange={(prompt) => updateCurrent({ prompt })} onKeyDown={handleKeyDown} onSend={() => void execute()} onStop={() => void cancelRun()}
        onCancelEdit={cancelMessageEdit}
        multiModel={currentSession.multiModel !== false}
        pinnedModelId={currentSession.multiModel === false ? (currentSession.modelId ?? defaultSessionModelId) : undefined}
        models={enabledModelOptions}
        onToggleMultiModel={toggleMultiModel}
        onSelectModel={selectSessionModel}
      />}
    </main>}
    {view === 'workspace' && projectDrawerOpen && <button className="panel-backdrop inspector-backdrop" aria-label="关闭项目面板" onClick={() => setProjectDrawerOpen(false)} />}
    {view === 'workspace' && projectDrawerOpen && <WorkspacePanel project={currentProject} reloadKey={projectReloadKey} activePath={activeFilePath} onPreview={openFile} onChangeDirectory={() => setShowNewProject(true)} />}
    {showSettings && <Settings models={models} onClose={() => setShowSettings(false)} onModelsChanged={handleModelsChanged} onOpenRouting={() => setShowRouting(true)} />}
    {showRouting && <RoutingPanel onClose={() => setShowRouting(false)} />}
    {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} onCreated={handleProjectCreated} />}
  </div>;
}

