import React, { useEffect, useRef, useState } from 'react';
import { Sidebar, SessionSummary } from './components/Sidebar';
import { DetailsPanel } from './components/DetailsPanel';
import { Settings } from './pages/Settings';
import { Dashboard } from './components/Dashboard';
import { MemoryPanel } from './components/MemoryPanel';
import { RoutingPanel } from './components/RoutingPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { ProjectPanel } from './components/ProjectPanel';
import { NewProjectDialog } from './components/NewProjectDialog';
import { AgentInputBar } from './components/AgentInputBar';
import { WorkbenchWelcome } from './components/WorkbenchWelcome';
import { OutputView } from './components/OutputView';
import { ToolCallList } from './components/ToolCallList';
import { ModelConfig, ProjectInfo, ProjectRecord, RunTrace, SessionMetrics } from './types';
import { appendAssistantChunk, ChatAgentMessage, ChatMessage, historyForModel, preparePendingTurn, restoreMessages, settleAssistantTools, ToolCallUpdate, updateAssistantAgent, updateLatestAssistantAttribution, updateLatestAssistantContent, upsertAssistantTool } from './sessionMessages';
import { BrainCircuit, ChevronDown, Copy, PanelLeft, PanelRight, Pencil, Sparkles, UsersRound, Waypoints, X } from 'lucide-react';
import { shouldSubmitPromptKey } from './promptKeyboard';
import { errorMessage } from './format';
import { completeSessionMetrics, restoreRouteConfidence, type SessionRunTiming } from './sessionMetrics';

interface Session extends SessionSummary { prompt: string; userMessage?: string; output: string; messages: ChatMessage[]; modelUsed?: string; runId?: string; routeConfidence?: number; metrics?: SessionMetrics; audit?: { passed: boolean; score: number; issueCount: number }; auditResult?: { passed: boolean; score: number; issueCount: number }; taskType?: string; rating?: number; updatedAt?: Date; }

const starterSession = (): Session => ({ id: `session-${Date.now()}`, title: '新的工作会话', prompt: '', userMessage: '', output: '', messages: [], createdAt: new Date() });

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
  const [showDashboard, setShowDashboard] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showRouting, setShowRouting] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectList, setProjectList] = useState<ProjectRecord[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectInfo>();
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectReloadKey, setProjectReloadKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 760);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(() => window.innerWidth >= 1180);
  const [isMacOS] = useState(() => navigator.userAgent.toLowerCase().includes('mac'));
  const [trace, setTrace] = useState<RunTrace>();
  const [liveTrace, setLiveTrace] = useState<RunTrace>();
  const currentRunIdRef = useRef<string | undefined>(undefined);
  const [sessionError, setSessionError] = useState<{ sessionId: string; message: string } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [selectedAgentModelIds, setSelectedAgentModelIds] = useState<string[]>([]);
  const [collaborationOpen, setCollaborationOpen] = useState(false);
  const [collaborationNotice, setCollaborationNotice] = useState<string | null>(null);
  const [includeProjectContext, setIncludeProjectContext] = useState(true);
  const workspaceContentRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const promptBeforeEditingRef = useRef('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const runTimingRef = useRef<SessionRunTiming | null>(null);
  const [liveElapsedMs, setLiveElapsedMs] = useState(0);
  const currentSession = sessions.find((session) => session.id === currentSessionId) || null;
  const currentModel = currentSession?.modelUsed ? models.find((model) => model.id === currentSession.modelUsed || model.name === currentSession.modelUsed) : undefined;
  // Only one task runs at a time; track which session owns it so other sessions don't show its spinner or error.
  const isLoading = runningSessionId !== null;
  const isCurrentRunning = isLoading && runningSessionId === currentSessionId;
  const error = sessionError?.sessionId === currentSessionId ? sessionError.message : null;
  const modelLabel = (id?: string) => id ? models.find((model) => model.id === id || model.name === id)?.name || id : undefined;
  const latestAssistant = currentSession?.messages.slice().reverse().find((message) => message.role === 'assistant');
  const bannerModels = [modelLabel(latestAssistant?.planningModelId), modelLabel(latestAssistant?.modelUsed ?? currentSession?.modelUsed)].filter(Boolean).join(' + ') || '自动路由';
  const branchLabel = currentProject?.git?.branch ?? currentProject?.git?.head;
  const withRunTiming = (metrics: SessionMetrics | undefined, sessionId: string, confidence: number | undefined, hasOutput: boolean): SessionMetrics | undefined => {
    const timing = runTimingRef.current;
    return completeSessionMetrics(metrics, timing?.sessionId === sessionId ? timing : undefined, confidence, hasOutput, performance.now());
  };

  useEffect(() => {
    const runId = currentSession?.runId;
    if (!runId) { setTrace(undefined); return; }
    let active = true;
    void window.amd?.trace?.get(runId)
      .then((value) => { if (active) setTrace(value as RunTrace | undefined); })
      .catch(() => { if (active) setTrace(undefined); });
    return () => { active = false; };
  }, [currentSession?.runId]);

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
      setCollaborationOpen(false);
      if (window.innerWidth < 1180) setProjectDrawerOpen(false);
      if (window.innerWidth < 760) setSidebarOpen(false);
    };
    const closePicker = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.collaboration-picker, .collaboration-toggle')) setCollaborationOpen(false);
    };
    window.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', closePicker);
    return () => { window.removeEventListener('keydown', dismiss); document.removeEventListener('pointerdown', closePicker); };
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
      const event = payload as { sessionId?: string; taskId?: string; modelId?: string; role?: 'routing' | 'planning' | 'execution'; planningModelId?: string; confidence?: number };
      const id = event.sessionId || event.taskId;
      if (!id || !event.modelId) return;
      const timing = runTimingRef.current;
      if (timing?.sessionId === id && event.confidence !== undefined) timing.routeConfidence = event.confidence;
      setSessions((existing) => existing.map((session) => {
        if (session.id !== id) return session;
        if (event.role === 'routing') return { ...session, routeConfidence: event.confidence };
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
      const event = payload as { sessionId?: string; assistantMessageId?: string; agentId?: string; status?: ChatAgentMessage['status']; delta?: string; content?: string; error?: string };
      if (!event.sessionId || !event.assistantMessageId || !event.agentId) return;
      setSessions((existing) => existing.map((session) => session.id === event.sessionId ? {
        ...session,
        messages: updateAssistantAgent(session.messages, event.assistantMessageId!, {
          agentId: event.agentId!, status: event.status, delta: event.delta, content: event.content, error: event.error,
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
      setSessions((existing) => existing.map((session) => session.id === id ? {
        ...session,
        messages: updateLatestAssistantContent(session.messages, event.output ?? '', modelUsed, event.planningModelId),
        output: event.output ?? '', modelUsed, runId: event.runId ?? session.runId, routeConfidence: metrics?.routeConfidence, metrics,
      } : session));
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
  const applyProject = (project: ProjectInfo | undefined) => { setCurrentProject(project); setProjectReloadKey((key) => key + 1); setProjectError(null); void refreshProjects(); };
  const openProject = async (id: string) => {
    if (!window.amd) return;
    try { applyProject(await window.amd.projects.open(id)); }
    catch (cause) { const message = errorMessage(cause); setProjectError(message.includes('不存在') ? `${message}，可将其从列表移除` : message); }
  };
  const removeProject = async (id: string) => {
    try {
      await window.amd?.projects.remove(id);
      if (currentProject?.id === id) setCurrentProject(undefined);
      setProjectError(null);
      void refreshProjects();
    } catch (cause) { setProjectError(errorMessage(cause)); }
  };
  const clearProject = async () => { await window.amd?.project.clear(); applyProject(undefined); };
  const handleProjectCreated = (project: ProjectInfo) => { setShowNewProject(false); applyProject(project); setProjectDrawerOpen(true); };

  const updateCurrent = (patch: Partial<Session>) => setSessions((existing) => existing.map((session) => session.id === currentSessionId ? { ...session, ...patch } : session));
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
  const selectSession = (id: string) => { if (editingMessageId) cancelMessageEdit(); setCurrentSessionId(id); };
  const newSession = () => { if (editingMessageId) cancelMessageEdit(); const session = starterSession(); setSessions((existing) => [session, ...existing]); setCurrentSessionId(session.id); setSessionError(null); void window.amd?.sessions.save({ ...session, updatedAt: new Date() }); };
  const deleteSession = (id: string) => { if (editingMessageId && currentSessionId === id) cancelMessageEdit(); const remaining = sessions.filter((session) => session.id !== id); setSessions(remaining); if (currentSessionId === id) setCurrentSessionId(remaining[0]?.id || null); void window.amd?.sessions.delete(id); };
  const fillCollaborationExample = () => {
    const enabledModels = models.filter((model) => model.enabled && (model.hasApiKey || model.provider === 'custom')).slice(0, 2);
    setCollaborationOpen(true);
    if (enabledModels.length < 2) {
      setCollaborationNotice('先在模型配置中启用至少两款模型，才能运行并行示例。');
      return;
    }
    setSelectedAgentModelIds(enabledModels.map((model) => model.id));
    setCollaborationNotice(null);
    updateCurrent({ prompt: '请并行评估“把任务拆给多个模型独立分析后再汇总”这个方案，分别说明收益、风险和验证步骤，并给出最终建议。' });
  };
  const handleModelsChanged = (nextModels: ModelConfig[]) => {
    setModels(nextModels);
    setSelectedAgentModelIds((current) => current.filter((id) => nextModels.some((model) => model.id === id && model.enabled && (model.hasApiKey || model.provider === 'custom'))));
  };
  const execute = async () => {
    // Enter bypasses the disabled send button, so guard here too.
    if (!currentSession || !currentSession.prompt.trim() || isLoading) return;
    if (selectedAgentModelIds.length === 1) { setCollaborationNotice('并行协作至少需要两款已启用模型。'); setCollaborationOpen(true); return; }
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
    const collaboratorModels = models.filter((model) => selectedAgentModelIds.includes(model.id) && model.enabled && (model.hasApiKey || model.provider === 'custom'));
    const messages = preparePendingTurn(currentSession.messages, messageId, prompt, editingMessageId ?? undefined, collaboratorModels.map(({ id, name }) => ({ id, name })));
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
        collaboratorModelIds: collaboratorModels.map((model) => model.id),
        // Earlier turns of this conversation (the pending user/assistant pair is the last two).
        history: historyForModel(messages.slice(0, -2)),
      });
      const raw = result as any;
      const modelUsed = typeof raw.modelUsed === 'string' ? raw.modelUsed : raw.modelUsed?.id || raw.modelUsed?.name;
      const output = String(raw.output || '');
      const metrics = withRunTiming(raw.metrics, currentSession.id, raw.decision?.confidence, Boolean(output));
      let completedMessages = updateLatestAssistantContent(messages, output, modelUsed, raw.planningModelId);
      for (const agent of (raw.agentMessages || []) as ChatAgentMessage[]) {
        completedMessages = updateAssistantAgent(completedMessages, `${messageId}-assistant`, { agentId: agent.id, status: agent.status, content: agent.content, error: agent.error });
      }
      for (const call of (raw.toolCalls || []) as ToolCallUpdate[]) completedMessages = upsertAssistantTool(completedMessages, `${messageId}-assistant`, call);
      const completedSession: Session = { ...submittedSession, messages: completedMessages, output, modelUsed, runId: raw.runId ?? runId, routeConfidence: metrics?.routeConfidence, metrics, audit: raw.audit, auditResult: raw.audit, taskType: raw.decision?.taskType, updatedAt: new Date() };
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
        const failedSession: Session = { ...latestSession, runId, messages: settledMessages, updatedAt: new Date() };
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
  const rateCurrent = async (rating: number) => {
    if (!currentSession?.modelUsed || !window.amd) return;
    updateCurrent({ rating, updatedAt: new Date() });
    void window.amd.sessions.save({ ...currentSession, rating, updatedAt: new Date() });
    try { await window.amd.recordGrowthFeedback({ modelId: currentSession.modelUsed, taskType: currentSession.taskType ?? 'general', userSatisfaction: rating, completed: true }); } catch { /* feedback should never block the task UI */ }
  };
  // ⌘N / ⌘K (Ctrl on Windows/Linux) as shown in the sidebar; disabled while a dialog is open.
  const newSessionRef = useRef(newSession);
  newSessionRef.current = newSession;
  const modalOpen = showSettings || showDashboard || showTerminal || showNewProject || showMemory || showRouting;
  useEffect(() => {
    if (modalOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(isMacOS ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n') { event.preventDefault(); newSessionRef.current(); }
      else if (key === 'k') { event.preventDefault(); setSidebarOpen(true); requestAnimationFrame(() => searchInputRef.current?.focus()); }
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

  return <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} ${projectDrawerOpen ? 'drawer-open' : ''} ${isMacOS ? 'mac-shell' : ''}`}>
    <Sidebar sessions={sessions} currentSessionId={currentSessionId} runningSessionId={runningSessionId} projects={projectList} activeProjectId={currentProject?.id} projectError={projectError} isMacOS={isMacOS} searchInputRef={searchInputRef} onNewSession={newSession} onSelectSession={selectSession} onDeleteSession={deleteSession} onSettings={() => setShowSettings(true)} onMonitoring={() => setShowDashboard(true)} onTerminal={() => setShowTerminal(true)} onNewProject={() => setShowNewProject(true)} onOpenProject={(id) => void openProject(id)} onRemoveProject={(id) => void removeProject(id)} />
    {sidebarOpen && <button className="panel-backdrop sidebar-backdrop" aria-label="关闭导航栏" onClick={() => setSidebarOpen(false)} />}
    <main className="workspace">
      <header className="workspace-header">
        <div className="workspace-title"><div className="eyebrow">Agent Workspace</div><h1><span className="title-text">{currentSession?.title || '开始一个新任务'}</span>{currentProject && <span className="header-pill" title={currentProject.root}><i className="live-dot pulse" />{currentProject.name}{branchLabel ? ` · ${branchLabel} 分支` : ''} · 工作区就绪</span>}</h1></div>
        <div className="header-actions">
          <span className="status-pill header-status"><i className="live-dot" />本地加密</span>
          <button className="icon-button" title="长期记忆" aria-label="长期记忆" onClick={() => setShowMemory(true)}><BrainCircuit size={16} /></button>
          <button className="icon-button" title="路由规则" aria-label="路由规则" onClick={() => setShowRouting(true)}><Waypoints size={16} /></button>
          <span className="panel-divider" />
          <button className="icon-button" title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'} aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'} aria-pressed={sidebarOpen} onClick={() => setSidebarOpen((open) => !open)}><PanelLeft size={16} /></button>
          <button className="icon-button" title={projectDrawerOpen ? '关闭右侧面板' : '打开右侧面板'} aria-label={projectDrawerOpen ? '关闭右侧面板' : '打开右侧面板'} aria-pressed={projectDrawerOpen} onClick={() => setProjectDrawerOpen((open) => !open)}><PanelRight size={16} /></button>
        </div>
      </header>
      <div ref={workspaceContentRef} className={`workspace-content ${currentSession && !currentSession.messages.length ? 'empty-workspace' : ''}`}>
        {currentSession ? <section className="chat-thread" aria-label="会话消息">
          {!!currentSession.messages.length && <div className="session-banner">
            <div className="banner-left"><span className="brand-tile"><Sparkles size={15} /></span><strong>newAi</strong><span className="model-chip mono" title="最近一次回复使用的模型">{bannerModels}</span></div>
            <span className="status-pill"><i className={isCurrentRunning ? 'live-dot pulse' : 'live-dot'} />{currentProject ? '项目上下文已关联' : '自动路由就绪'}</span>
          </div>}
          {currentSession.messages.length ? currentSession.messages.map((message, index) => {
            const live = isCurrentRunning && index === currentSession.messages.length - 1;
            if (message.role === 'user') return <div key={message.id} className="user-message-row"><div className="user-message-bubble"><div className="user-message-text">{message.content}</div><div className="user-message-footer"><button className="message-icon-button" title="复制消息" aria-label="复制消息" onClick={() => void navigator.clipboard?.writeText(message.content)}><Copy size={14} strokeWidth={1.8} /></button><button className="message-icon-button" title="编辑消息" aria-label="编辑消息" disabled={isLoading} onClick={() => startMessageEdit(message)}><Pencil size={14} strokeWidth={1.8} /></button></div></div></div>;
            return <div key={message.id} className="assistant-turn">
              {live && !message.content && <div className="thinking-pill"><i className="live-dot pulse" />思考中 · 正在路由并选择执行模型</div>}
              <article className="assistant-card">
                <header className="assistant-card-header">
                  <span className="assistant-title"><i className={live ? 'live-dot pulse' : 'live-dot'} /><strong>{modelLabel(message.modelUsed) ?? (live ? '正在选择执行模型' : 'newAi')}</strong>{message.planningModelId && <small className="planning-attribution">规划：{modelLabel(message.planningModelId)}</small>}</span>
                  {live ? <span className="streaming-badge mono">Streaming</span> : message.content && <button className="message-icon-button" title="复制回复" aria-label="复制回复" onClick={() => void navigator.clipboard?.writeText(message.content)}><Copy size={14} strokeWidth={1.8} /></button>}
                </header>
                {!!message.tools?.length && <ToolCallList tools={message.tools} />}
                <OutputView content={message.content} loading={live && Boolean(message.content)} emptyState={false} />
                {!!message.agents?.length && <section className="agent-board" aria-label="并行子智能体报告"><div className="agent-board-heading"><UsersRound size={15} /><strong>子智能体报告</strong><span>{message.agents.filter((agent) => agent.status === 'completed').length}/{message.agents.length} 完成</span></div>{message.agents.map((agent) => <div className="agent-report" key={agent.id}><header><strong>{agent.modelName}</strong><span className={`agent-status ${agent.status}`}>{({ queued: '等待中', running: '分析中', completed: '已完成', failed: '失败' })[agent.status]}</span></header>{agent.content ? <OutputView content={agent.content} loading={agent.status === 'running'} emptyState={false} /> : agent.status === 'running' ? <p className="agent-placeholder">正在独立分析…</p> : null}{agent.error && <div className="agent-error">{agent.error}</div>}</div>)}</section>}
                {error && index === currentSession.messages.length - 1 && <div className="error-banner">{error}</div>}
              </article>
            </div>;
          }) : <WorkbenchWelcome onChoose={(prompt) => { updateCurrent({ prompt }); promptInputRef.current?.focus(); }} onOpenProject={() => setShowNewProject(true)} />}
        </section> : <div className="no-session"><strong>创建一个会话开始工作</strong><button className="button primary" onClick={newSession}>新建会话</button></div>}
      </div>
      {currentSession && <AgentInputBar
        project={currentProject} value={currentSession.prompt} inputRef={promptInputRef}
        hasMessages={currentSession.messages.length > 0} busy={isLoading} running={isCurrentRunning} editing={Boolean(editingMessageId)}
        onChange={(prompt) => updateCurrent({ prompt })} onKeyDown={handleKeyDown} onSend={() => void execute()} onStop={() => void cancelRun()}
        onOpenContext={() => currentProject ? setProjectDrawerOpen(true) : setShowNewProject(true)} onCancelEdit={cancelMessageEdit}
        notice={collaborationNotice}
        includeProjectContext={includeProjectContext}
        onToggleProjectContext={() => setIncludeProjectContext((value) => !value)}
        collaborationControl={<button className={`collaboration-toggle ${selectedAgentModelIds.length ? 'active' : ''}`} aria-label="选择协作模型" aria-expanded={collaborationOpen} aria-controls="collaboration-models" onClick={() => { setCollaborationOpen((open) => !open); setCollaborationNotice(null); }}><UsersRound size={14} /><span>{selectedAgentModelIds.length ? `协作 · ${selectedAgentModelIds.length}` : '协作'}</span><ChevronDown className={collaborationOpen ? 'open' : ''} size={12} /></button>}
        collaborationPicker={collaborationOpen && <div className="collaboration-picker" id="collaboration-models" role="group" aria-label="并行分析模型"><div className="collaboration-picker-heading"><strong>并行分析模型</strong><span>选择 2–4 款模型</span></div>{models.filter((model) => model.enabled && (model.hasApiKey || model.provider === 'custom')).map((model) => <label key={model.id} className="collaboration-option"><input type="checkbox" checked={selectedAgentModelIds.includes(model.id)} disabled={!selectedAgentModelIds.includes(model.id) && selectedAgentModelIds.length >= 4} onChange={(event) => { setCollaborationNotice(null); setSelectedAgentModelIds((current) => event.target.checked ? [...current, model.id] : current.filter((id) => id !== model.id)); }} /><span>{model.name}</span><small>{model.provider}</small></label>)}{models.every((model) => !model.enabled) && <div className="collaboration-empty">在模型设置中启用模型，即可开始协作。</div>}{selectedAgentModelIds.length === 1 && <div className="collaboration-notice">再选择一款模型以启用并行分析。</div>}<div className="collaboration-picker-actions"><button onClick={() => { setCollaborationOpen(false); setShowSettings(true); }}>管理模型</button><button onClick={fillCollaborationExample}>填入协作示例</button></div></div>}
      />}
    </main>
    {projectDrawerOpen && <button className="panel-backdrop inspector-backdrop" aria-label="关闭项目面板" onClick={() => setProjectDrawerOpen(false)} />}
    {projectDrawerOpen && <aside className="right-drawer" aria-label="项目与运行信息">
      <div className="drawer-header"><div><div className="eyebrow">Project Workspace</div><h2>项目文件</h2></div><button className="icon-button" title="关闭右侧面板" aria-label="关闭右侧面板" onClick={() => setProjectDrawerOpen(false)}><X size={16} /></button></div>
      <div className="drawer-scroll"><ProjectPanel project={currentProject} reloadKey={projectReloadKey} onChangeDirectory={() => setShowNewProject(true)} onClear={() => void clearProject()} /></div>
      <DetailsPanel model={currentSession?.modelUsed} modelId={currentSession?.modelUsed} modelConfig={currentModel} planningModelName={modelLabel(latestAssistant?.planningModelId)} confidence={currentSession?.routeConfidence} metrics={isCurrentRunning ? { latencyMs: liveElapsedMs, ttftMs: runTimingRef.current?.ttftMs } : currentSession?.metrics} trace={trace ?? liveTrace} audit={currentSession?.audit} running={isCurrentRunning} error={error} rating={currentSession?.rating} onRate={(rating) => void rateCurrent(rating)} />
    </aside>}
    {showSettings && <Settings models={models} onClose={() => setShowSettings(false)} onModelsChanged={handleModelsChanged} />}
    {showMemory && <MemoryPanel onClose={() => setShowMemory(false)} hasProject={Boolean(currentProject)} />}
    {showRouting && <RoutingPanel onClose={() => setShowRouting(false)} />}
    {showDashboard && <Dashboard onClose={() => setShowDashboard(false)} />}
    {showTerminal && <TerminalPanel onClose={() => setShowTerminal(false)} />}
    {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} onCreated={handleProjectCreated} />}
  </div>;
}

