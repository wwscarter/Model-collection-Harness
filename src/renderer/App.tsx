import React, { useEffect, useRef, useState } from 'react';
import { Sidebar, SessionSummary } from './components/Sidebar';
import { DetailsPanel } from './components/DetailsPanel';
import { Settings } from './pages/Settings';
import { Dashboard } from './components/Dashboard';
import { TerminalPanel } from './components/TerminalPanel';
import { ProjectPanel } from './components/ProjectPanel';
import { NewProjectDialog } from './components/NewProjectDialog';
import { ModelConfig, ProjectInfo, ProjectRecord, SessionMetrics } from './types';
import { appendAssistantChunk, ChatAgentMessage, ChatMessage, preparePendingTurn, restoreMessages, updateAssistantAgent, updateLatestAssistantAttribution, updateLatestAssistantContent } from './sessionMessages';
import { ArrowUp, Check, ChevronDown, Copy, FileCode, Folder, GitBranch, Monitor, PanelLeft, PanelRight, Pencil, Plus, Sparkles, TriangleAlert, UsersRound, X } from 'lucide-react';
import { shouldSubmitPromptKey } from './promptKeyboard';
import { errorMessage } from './format';

interface Session extends SessionSummary { prompt: string; userMessage?: string; output: string; messages: ChatMessage[]; modelUsed?: string; routeConfidence?: number; metrics?: SessionMetrics; rating?: number; updatedAt?: Date; }

const starterSession = (): Session => ({ id: `session-${Date.now()}`, title: '新的工作会话', prompt: '', userMessage: '', output: '', messages: [], createdAt: new Date() });

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  return <div className="code-block"><div className="code-block-header"><span><FileCode size={13} /><span className="mono">{language || 'text'}</span></span><button onClick={copy} title="复制代码">{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? '已复制' : '复制代码'}</button></div><pre><code>{code}</code></pre></div>;
}

function OutputView({ content, loading, emptyState }: { content: string; loading: boolean; emptyState: boolean }) {
  if (loading && !content) return <div className="output-pending"><i className="live-dot pulse" />正在规划并执行任务…</div>;
  if (!content && !emptyState) return null;
  if (!content) return <div className="output-empty"><strong>输出会显示在这里</strong><span>描述你的任务，newAi 会自动选择模型并执行。</span></div>;
  const parts = content.split(/```([\w-]*)\n?([\s\S]*?)```/g);
  const nodes: React.ReactNode[] = [];
  for (let index = 0; index < parts.length; index += 3) {
    // Code blocks have their own margins; drop the blank lines that surround the fences.
    let text = parts[index];
    if (index > 0) text = text.replace(/^\n+/, '');
    if (parts[index + 2] !== undefined) text = text.replace(/\n+$/, '');
    if (text) nodes.push(<div key={`text-${index}`} className="markdown-text">{text.split('\n').map((line, lineIndex) => <React.Fragment key={lineIndex}>{line.startsWith('#') ? <strong>{line.replace(/^#+\s*/, '')}</strong> : line}{lineIndex < text.split('\n').length - 1 && <br />}</React.Fragment>)}</div>);
    if (parts[index + 2] !== undefined) nodes.push(<CodeBlock key={`code-${index}`} language={parts[index + 1]} code={parts[index + 2]} />);
  }
  return <div className="output-content">{nodes}{loading && <span className="streaming-cursor" aria-label="正在生成">▍</span>}</div>;
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([starterSession()]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectList, setProjectList] = useState<ProjectRecord[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectInfo>();
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectReloadKey, setProjectReloadKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [isMacOS] = useState(() => navigator.userAgent.toLowerCase().includes('mac'));
  const [sessionError, setSessionError] = useState<{ sessionId: string; message: string } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [selectedAgentModelIds, setSelectedAgentModelIds] = useState<string[]>([]);
  const [collaborationOpen, setCollaborationOpen] = useState(false);
  const [collaborationNotice, setCollaborationNotice] = useState<string | null>(null);
  const workspaceContentRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const promptBeforeEditingRef = useRef('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
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

  useEffect(() => {
    const content = workspaceContentRef.current;
    if (content) content.scrollTop = content.scrollHeight;
  }, [currentSessionId, currentSession?.messages]);

  useEffect(() => {
    setEditingMessageId(null);
    promptBeforeEditingRef.current = '';
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

    void window.amd?.sessions.list().then((records) => {
      const restored = records.map((record) => ({
        id: String(record.id), title: String(record.title || '未命名会话'), prompt: String(record.prompt || ''), userMessage: String(record.userMessage || ''), output: String(record.output || ''), messages: restoreMessages(record),
        modelUsed: record.modelUsed ? String(record.modelUsed) : undefined, metrics: record.metrics as SessionMetrics | undefined,
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
    const unsubscribe = window.amd?.on('session:completed', (payload) => {
      const event = payload as { sessionId?: string; taskId?: string; output?: string; modelUsed?: string | { id?: string; name?: string }; planningModelId?: string; decision?: { confidence?: number }; metrics?: SessionMetrics };
      const id = event.sessionId || event.taskId;
      if (!id) return;
      const modelUsed = typeof event.modelUsed === 'string' ? event.modelUsed : event.modelUsed?.id || event.modelUsed?.name;
      const rawMetrics = event.metrics as SessionMetrics & { totalCost?: number; latency?: number } | undefined;
      const metrics = rawMetrics && rawMetrics.totalCost !== undefined ? { inputTokens: rawMetrics.inputTokens, outputTokens: rawMetrics.outputTokens, latencyMs: rawMetrics.latency, cost: rawMetrics.totalCost } : event.metrics;
      setSessions((existing) => existing.map((session) => session.id === id ? {
        ...session,
        messages: updateLatestAssistantContent(session.messages, event.output ?? '', modelUsed, event.planningModelId),
        output: event.output ?? '', modelUsed, routeConfidence: event.decision?.confidence, metrics,
      } : session));
    });
    return () => { unsubscribeChunk?.(); unsubscribeModel?.(); unsubscribeAgent?.(); unsubscribe?.(); };
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
    const enabledModels = models.filter((model) => model.enabled).slice(0, 2);
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
    setSelectedAgentModelIds((current) => current.filter((id) => nextModels.some((model) => model.id === id && model.enabled)));
  };
  const execute = async () => {
    // Enter bypasses the disabled send button, so guard here too.
    if (!currentSession || !currentSession.prompt.trim() || isLoading) return;
    if (selectedAgentModelIds.length === 1) { setCollaborationNotice('并行协作至少需要两款已启用模型。'); setCollaborationOpen(true); return; }
    const prompt = currentSession.prompt.trim();
    const title = prompt.slice(0, 36);
    const messageId = crypto.randomUUID();
    const collaboratorModels = models.filter((model) => selectedAgentModelIds.includes(model.id) && model.enabled);
    const messages = preparePendingTurn(currentSession.messages, messageId, prompt, editingMessageId ?? undefined, collaboratorModels.map(({ id, name }) => ({ id, name })));
    const submittedSession: Session = { ...currentSession, prompt: '', userMessage: prompt, output: '', messages, title, updatedAt: new Date() };
    promptBeforeEditingRef.current = '';
    setEditingMessageId(null);
    setSessionError(null);
    setRunningSessionId(currentSession.id);
    setSessions((existing) => existing.map((session) => session.id === currentSession.id ? submittedSession : session));
    try {
      if (!window.amd) throw new Error('主进程尚未连接，请在 Electron 中运行应用。');
      await window.amd.sessions.save(submittedSession);
      // 流式执行，不等待完全完成 - 由事件监听器处理结果
      const result = await window.amd.sessions.execute({
        sessionId: currentSession.id,
        taskId: currentSession.id,
        assistantMessageId: `${messageId}-assistant`,
        prompt,
        taskType: 'general',
        stream: true,
        collaboratorModelIds: collaboratorModels.map((model) => model.id),
      });
      const raw = result as any;
      const modelUsed = typeof raw.modelUsed === 'string' ? raw.modelUsed : raw.modelUsed?.id || raw.modelUsed?.name;
      const rawMetrics = raw.metrics as SessionMetrics & { totalCost?: number; latency?: number } | undefined;
      const metrics = rawMetrics && rawMetrics.totalCost !== undefined ? {
        inputTokens: rawMetrics.inputTokens,
        outputTokens: rawMetrics.outputTokens,
        latencyMs: rawMetrics.latency,
        cost: rawMetrics.totalCost
      } : raw.metrics;
      const output = String(raw.output || '');
      let completedMessages = updateLatestAssistantContent(messages, output, modelUsed, raw.planningModelId);
      for (const agent of (raw.agentMessages || []) as ChatAgentMessage[]) {
        completedMessages = updateAssistantAgent(completedMessages, `${messageId}-assistant`, { agentId: agent.id, status: agent.status, content: agent.content, error: agent.error });
      }
      const completedSession: Session = { ...submittedSession, messages: completedMessages, output, modelUsed, routeConfidence: raw.decision?.confidence, metrics, updatedAt: new Date() };
      setSessions((existing) => existing.map((session) => session.id === currentSession.id ? completedSession : session));
      await window.amd.sessions.save(completedSession);
    } catch (cause) {
      setSessionError({ sessionId: currentSession.id, message: errorMessage(cause) });
    } finally {
      setRunningSessionId(null);
    }
  };
  const rateCurrent = async (rating: number) => {
    if (!currentSession?.modelUsed || !window.amd) return;
    updateCurrent({ rating, updatedAt: new Date() });
    void window.amd.sessions.save({ ...currentSession, rating, updatedAt: new Date() });
    try { await window.amd.recordGrowthFeedback({ modelId: currentSession.modelUsed, taskType: 'general', userSatisfaction: rating, completed: true }); } catch { /* feedback should never block the task UI */ }
  };
  // ⌘N / ⌘K (Ctrl on Windows/Linux) as shown in the sidebar; disabled while a dialog is open.
  const newSessionRef = useRef(newSession);
  newSessionRef.current = newSession;
  const modalOpen = showSettings || showDashboard || showTerminal || showNewProject;
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
    <main className="workspace">
      <header className="workspace-header">
        <div className="workspace-title"><div className="eyebrow">Agent Workspace</div><h1><span className="title-text">{currentSession?.title || '开始一个新任务'}</span>{currentProject && <span className="header-pill" title={currentProject.root}><i className="live-dot pulse" />{currentProject.name}{branchLabel ? ` · ${branchLabel} 分支` : ''} · 工作区就绪</span>}</h1></div>
        <div className="header-actions">
          <span className="status-pill header-status"><i className="live-dot" />本地加密</span>
          <span className="panel-divider" />
          <button className="icon-button" title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'} aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'} aria-pressed={sidebarOpen} onClick={() => setSidebarOpen((open) => !open)}><PanelLeft size={16} /></button>
          <button className="icon-button" title={projectDrawerOpen ? '关闭右侧面板' : '打开右侧面板'} aria-label={projectDrawerOpen ? '关闭右侧面板' : '打开右侧面板'} aria-pressed={projectDrawerOpen} onClick={() => setProjectDrawerOpen((open) => !open)}><PanelRight size={16} /></button>
        </div>
      </header>
      <div ref={workspaceContentRef} className="workspace-content">
        {currentSession ? <section className="chat-thread" aria-label="会话消息">
          <div className="session-banner">
            <div className="banner-left"><span className="brand-tile"><Sparkles size={15} /></span><strong>newAi</strong><span className="model-chip mono" title="最近一次回复使用的模型">{bannerModels}</span></div>
            <span className="status-pill"><i className="live-dot pulse" />{currentProject ? `已关联项目上下文 · ${currentProject.name}` : '自动路由就绪'}</span>
          </div>
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
                <OutputView content={message.content} loading={live && Boolean(message.content)} emptyState={false} />
                {!!message.agents?.length && <section className="agent-board" aria-label="并行子智能体报告"><div className="agent-board-heading"><UsersRound size={15} /><strong>子智能体报告</strong><span>{message.agents.filter((agent) => agent.status === 'completed').length}/{message.agents.length} 完成</span></div>{message.agents.map((agent) => <div className="agent-report" key={agent.id}><header><strong>{agent.modelName}</strong><span className={`agent-status ${agent.status}`}>{({ queued: '等待中', running: '分析中', completed: '已完成', failed: '失败' })[agent.status]}</span></header>{agent.content ? <OutputView content={agent.content} loading={agent.status === 'running'} emptyState={false} /> : agent.status === 'running' ? <p className="agent-placeholder">正在独立分析…</p> : null}{agent.error && <div className="agent-error">{agent.error}</div>}</div>)}</section>}
                {error && index === currentSession.messages.length - 1 && <div className="error-banner">{error}</div>}
              </article>
            </div>;
          }) : <div className="empty-thread"><OutputView content="" loading={false} emptyState /></div>}
        </section> : <div className="no-session"><strong>创建一个会话开始工作</strong><button className="button primary" onClick={newSession}>新建会话</button></div>}
      </div>
      {currentSession && <section className="composer" aria-label="任务输入">
        <div className="composer-tabs">
          <button className={`composer-tab ${currentProject ? 'accent' : ''}`} title={currentProject ? currentProject.root : '绑定本地项目'} onClick={() => currentProject ? setProjectDrawerOpen(true) : setShowNewProject(true)}><Folder size={15} /><span>{currentProject?.name ?? '未绑定项目'}</span></button>
          <span className="composer-tab static" title="任务在本机执行"><Monitor size={15} /><span>本地</span></span>
          {branchLabel && <span className="composer-tab static" title="当前 Git 分支"><GitBranch size={15} /><span>{branchLabel}</span></span>}
        </div>
        <div className="prompt-card">
          {editingMessageId && <div className="prompt-editing-bar"><span>正在编辑消息 · 重新发送将替换此轮及之后内容</span><button className="message-icon-button" title="取消编辑" aria-label="取消编辑" onClick={cancelMessageEdit}><X size={16} strokeWidth={1.8} /></button></div>}
          <div className="collaboration-toolbar"><button className={`collaboration-toggle ${selectedAgentModelIds.length ? 'active' : ''}`} aria-expanded={collaborationOpen} onClick={() => { setCollaborationOpen((open) => !open); setCollaborationNotice(null); }}><UsersRound size={15} /><span>{selectedAgentModelIds.length ? `子智能体 · ${selectedAgentModelIds.length}` : '添加子智能体'}</span><ChevronDown className={collaborationOpen ? 'open' : ''} size={14} /></button><button className="example-task-button" onClick={fillCollaborationExample}>填入协作测试任务</button></div>
          {collaborationNotice && <div className="collaboration-notice">{collaborationNotice}</div>}
          {collaborationOpen && <div className="collaboration-picker"><div className="collaboration-picker-heading"><strong>并行分析模型</strong><span>选择 2–4 款已启用模型</span></div>{models.filter((model) => model.enabled).map((model) => <label key={model.id} className="collaboration-option"><input type="checkbox" checked={selectedAgentModelIds.includes(model.id)} disabled={!selectedAgentModelIds.includes(model.id) && selectedAgentModelIds.length >= 4} onChange={(event) => { setCollaborationNotice(null); setSelectedAgentModelIds((current) => event.target.checked ? [...current, model.id] : current.filter((id) => id !== model.id)); }} /><span>{model.name}</span><small>{model.provider}</small></label>)}{models.every((model) => !model.enabled) && <div className="collaboration-empty">没有已启用模型</div>}{selectedAgentModelIds.length === 1 && <div className="collaboration-notice">再选择一款模型以启用并行分析。</div>}</div>}
          <textarea ref={promptInputRef} value={currentSession.prompt} onChange={(event) => updateCurrent({ prompt: event.target.value })} onKeyDown={handleKeyDown} placeholder={currentSession.messages.length ? '输入追加指令或反馈，按 Enter 发送，Shift + Enter 换行…' : '描述你想要完成的任务，按 Enter 发送，Shift + Enter 换行…'} aria-label={editingMessageId ? '编辑消息' : '描述任务'} />
          <footer>
            <div className="dock-left"><button className="attach-button" title="打开项目文件" aria-label="打开项目文件" onClick={() => setProjectDrawerOpen(true)}><Plus size={18} /></button><span className="access-badge" title="终端与命令执行可以访问本机文件"><TriangleAlert size={12} />完全访问</span></div>
            <div className="dock-right"><button className="model-selector" title="管理已配置模型" onClick={() => setShowSettings(true)}><span>{currentModel?.name || '自动路由'}</span><ChevronDown size={14} /></button><button className="send-button" title={isCurrentRunning ? '正在执行' : isLoading ? '另一个会话正在执行' : editingMessageId ? '重新生成回复' : '执行任务'} aria-label={isCurrentRunning ? '正在执行' : editingMessageId ? '重新生成回复' : '执行任务'} disabled={isLoading || !currentSession.prompt.trim()} onClick={() => void execute()}>{isCurrentRunning ? <span className="send-spinner" /> : editingMessageId ? <Check size={17} strokeWidth={2.2} /> : <ArrowUp size={17} strokeWidth={2.4} />}</button></div>
          </footer>
        </div>
      </section>}
    </main>
    {projectDrawerOpen && <aside className="right-drawer" aria-label="项目与运行信息">
      <div className="drawer-header"><div><div className="eyebrow">Project Workspace</div><h2>项目文件</h2></div><button className="icon-button" title="关闭右侧面板" aria-label="关闭右侧面板" onClick={() => setProjectDrawerOpen(false)}><X size={16} /></button></div>
      <div className="drawer-scroll"><ProjectPanel project={currentProject} reloadKey={projectReloadKey} onChangeDirectory={() => setShowNewProject(true)} onClear={() => void clearProject()} /></div>
      <DetailsPanel model={currentSession?.modelUsed} modelId={currentSession?.modelUsed} modelConfig={currentModel} planningModelName={modelLabel(latestAssistant?.planningModelId)} confidence={currentSession?.routeConfidence} metrics={isCurrentRunning ? undefined : currentSession?.metrics} running={isCurrentRunning} rating={currentSession?.rating} onRate={(rating) => void rateCurrent(rating)} />
    </aside>}
    {showSettings && <Settings models={models} onClose={() => setShowSettings(false)} onModelsChanged={handleModelsChanged} />}
    {showDashboard && <Dashboard onClose={() => setShowDashboard(false)} />}
    {showTerminal && <TerminalPanel onClose={() => setShowTerminal(false)} />}
    {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} onCreated={handleProjectCreated} />}
  </div>;
}

