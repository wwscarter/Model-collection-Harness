import React, { useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Settings } from './pages/Settings';
import { NavRail } from './components/NavRail';
import { MonitoringPage } from './pages/MonitoringPage';
import { RunHistoryPage } from './pages/RunHistoryPage';
import { RoutingPanel } from './components/RoutingPanel';
import { WorkspacePanel } from './components/WorkspacePanel';
import { TopBar } from './components/TopBar';
import { NewProjectDialog } from './components/NewProjectDialog';
import { AgentInputBar } from './components/AgentInputBar';
import { WorkbenchWelcome } from './components/WorkbenchWelcome';
import { OutputView } from './components/OutputView';
import { ToolCallList } from './components/ToolCallList';
import { VerificationStatus } from './components/VerificationStatus';
import { PlanCard } from './components/PlanCard';
import { Copy, Pencil, UsersRound } from 'lucide-react';
import { useSessionRun } from './hooks/useSessionRun';
import { useWorkspace } from './hooks/useWorkspace';

const formatDuration = (value?: number) => value === undefined || !Number.isFinite(value) ? undefined : value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(1) + ' s';

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'models' | 'runtime'>('models');
  const openSettings = (tab: 'models' | 'runtime' = 'models') => { setSettingsInitialTab(tab); setShowSettings(true); };
  const [showRouting, setShowRouting] = useState(false);
  const run = useSessionRun();
  const workspace = useWorkspace(run, showSettings, showRouting);
  const {
    sessions, currentSessionId, currentSession, models, setModels, runningSessionId,
    completionNotice, setCompletionNotice, liveTrace, projectReloadKey, isLoading,
    isCurrentRunning, bannerModels, modelLabel, liveElapsedMs, error, promptInputRef,
    updateCurrent, startMessageEdit, editingMessageId, handleKeyDown, execute, cancelRun,
    cancelMessageEdit, selectedSessionModelId, enabledModelOptions, toggleMultiModel, selectSessionModel,
    verificationMode, setVerificationMode, currentVerification,
    sessionRules, setSessionRules, sessionPlans, planError, decidePlan, planningMode, setPlanningMode,
  } = run;
  const {
    view, setView, openFiles, setOpenFiles, activeFilePath, setActiveFilePath, previewOpen,
    closePreview, toggleWorkspacePanel, sidebarOpen, setSidebarOpen, projectDrawerOpen,
    setProjectDrawerOpen, isMacOS, projectList, projectError, currentProject, openProject,
    removeProject, workspaceContentRef, newSession, selectSession, deleteSession,
    showNewProject, setShowNewProject, associateProject, gitBusy, initGit, approvalMode,
    openFile, handleProjectCreated,
  } = workspace;
  const navigate = (next: typeof view) => {
    setView(next);
    if (next !== 'workspace') { setProjectDrawerOpen(false); setActiveFilePath(undefined); setOpenFiles([]); }
  };
  return <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} ${projectDrawerOpen && view === 'workspace' ? 'drawer-open' : ''} ${previewOpen && projectDrawerOpen ? 'preview-open' : ''} ${isMacOS ? 'mac-shell' : ''} ${view !== 'workspace' ? 'monitoring-shell' : ''} ${view === 'runs' ? 'history-shell' : ''}`}>
    <TopBar title={view === 'runs' ? '运行记录' : view === 'monitoring' ? '运行监测' : currentSession?.title || '新建会话'} tabs={openFiles} activePath={activeFilePath} rightOpen={view === 'workspace' && projectDrawerOpen} previewOpen={previewOpen} showWorkspaceToggle={view === 'workspace'} onSelectTab={setActiveFilePath} onClosePreview={closePreview} onToggleRight={toggleWorkspacePanel} />
    <NavRail view={view} onView={navigate} onSettings={() => openSettings()} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((open) => !open)} />
    <Sidebar sessions={sessions} currentSessionId={currentSessionId} runningSessionId={runningSessionId} projects={projectList} activeProjectId={currentSession?.projectId} projectError={projectError} completionNotice={completionNotice} onClearCompletion={() => setCompletionNotice(false)} onNewSession={newSession} onSelectSession={selectSession} onDeleteSession={deleteSession} onNewProject={() => setShowNewProject(true)} onOpenProject={(id) => void openProject(id)} onRemoveProject={(id) => void removeProject(id)} />
    {sidebarOpen && view !== 'runs' && <button className="panel-backdrop sidebar-backdrop" aria-label="关闭导航栏" onClick={() => setSidebarOpen(false)} />}
    {view === 'runs' ? <RunHistoryPage liveTrace={liveTrace} onBack={() => navigate('monitoring')} /> : view === 'monitoring' ? <MonitoringPage liveTrace={liveTrace} onOpenRuns={() => navigate('runs')} /> : <main className="workspace">
      <div ref={workspaceContentRef} className={`workspace-content ${currentSession && !currentSession.messages.length ? 'empty-workspace' : ''}`}>
        {currentSession ? <section className="chat-thread" aria-label="会话消息">
          {!!currentSession.messages.length && <div className="chat-model-line"><span>{bannerModels}</span></div>}
          {currentSession.messages.length ? currentSession.messages.map((message, index) => {
            const live = isCurrentRunning && index === currentSession.messages.length - 1;
            if (message.role === 'user') return <div key={message.id} className="user-message-row"><div className="user-message-bubble"><div className="user-message-text">{message.content}</div><div className="user-message-footer"><button className="message-icon-button" title="复制消息" aria-label="复制消息" onClick={() => void navigator.clipboard?.writeText(message.content)}><Copy size={14} strokeWidth={1.8} /></button><button className="message-icon-button" title="编辑消息" aria-label="编辑消息" disabled={isLoading} onClick={() => startMessageEdit(message)}><Pencil size={14} strokeWidth={1.8} /></button></div></div></div>;
            return <div key={message.id} className="assistant-turn">
              {live && !message.content && !currentVerification && !sessionPlans.some((plan) => plan.assistantMessageId === message.id) && <div className="thinking-pill"><i className="live-dot pulse" />思考中 · 正在路由并选择执行模型</div>}
              {sessionPlans.filter((plan) => plan.assistantMessageId === message.id).map((plan) => <PlanCard key={plan.runId} record={plan} active={live} onDecision={decidePlan} />)}
              <article className="assistant-card">
                <header className="assistant-card-header">
                  <span className="assistant-title"><i className={live ? 'live-dot pulse' : 'live-dot'} /><strong>{modelLabel(message.modelUsed) ?? (live ? '正在选择执行模型' : 'newAi')}</strong>{message.planningModelId && <small className="planning-attribution">规划：{modelLabel(message.planningModelId)}</small>}{formatDuration(live ? liveElapsedMs : message.durationMs) && <small className="assistant-duration">{formatDuration(live ? liveElapsedMs : message.durationMs)}</small>}</span>
                  {live ? <span className="streaming-badge mono">Streaming</span> : message.content && <button className="message-icon-button" title="复制回复" aria-label="复制回复" onClick={() => void navigator.clipboard?.writeText(message.content)}><Copy size={14} strokeWidth={1.8} /></button>}
                </header>
                {live && !!message.tools?.length && <ToolCallList tools={message.tools} />}
                <OutputView content={message.content} loading={live && Boolean(message.content)} emptyState={false} />
                {live && !!message.agents?.length && <section className="agent-board" aria-label="并行子智能体报告"><div className="agent-board-heading"><UsersRound size={15} /><strong>子智能体报告</strong><span>{message.agents.filter((agent) => agent.status === 'completed').length}/{message.agents.length} 完成</span></div>{message.agents.map((agent) => <div className="agent-report" key={agent.id}><header><strong>{agent.modelName}</strong><span className={`agent-status ${agent.status}`}>{({ queued: '等待中', running: '分析中', completed: '已完成', failed: '失败' })[agent.status]}</span></header>{agent.content ? <OutputView content={agent.content} loading={agent.status === 'running'} emptyState={false} /> : agent.status === 'running' ? <p className="agent-placeholder">正在独立分析…</p> : null}{agent.error && <div className="agent-error">{agent.error}</div>}</div>)}</section>}
              </article>
            </div>;
          }) : <WorkbenchWelcome projectName={projectList.find((project) => project.id === currentSession.projectId)?.name} onChoose={(prompt) => { updateCurrent({ prompt }); promptInputRef.current?.focus(); }} onOpenProject={() => currentSession.projectId && projectList.some((project) => project.id === currentSession.projectId) ? setProjectDrawerOpen(true) : setShowNewProject(true)} />}
          <VerificationStatus event={currentVerification} />
          {planError && <div className="runtime-notice" role="alert">计划历史读取失败：{planError}</div>}
          {currentSession.metrics?.stopReason === 'tool_limit' && <div className="runtime-notice" role="status" aria-label="任务未完成">本轮工具预算已用尽，任务尚未完成。以上为阶段性总结，可继续任务。</div>}
          {currentSession.metrics?.stopReason === 'length' && <div className="runtime-notice" role="status" aria-label="输出长度已达上限">本轮输出已达到模型长度上限，任务尚未完成。已保留收到的内容，可继续任务或在模型设置中调整最大输出 Token。</div>}
          {currentSession.metrics?.stopReason === 'budget_limit' && <div className="runtime-notice budget-limit-notice" role="status" aria-label="任务预算已用尽"><span>{(currentSession.metrics.budgetLimit?.message || '本轮已达到预估费用或运行时间上限').replace(/[。.!！?？]+$/, '')}。任务尚未完成，{currentSession.output ? '已保留阶段性输出。' : '当前尚无可展示的输出。'}可调整预算后继续。</span>{currentSession.metrics.budgetLimit && <small>本轮预估费用 {'$'}{currentSession.metrics.budgetLimit.estimatedCost.toFixed(4)} · 费用上限 {'$'}{currentSession.metrics.budgetLimit.maxCostUsd.toFixed(2)}</small>}<button type="button" className="button outline small" onClick={() => openSettings('runtime')}>调整运行预算</button><small>设置 → 运行与权限 → 任务路由与模型分工</small></div>}
          {error && <div className="error-banner" role="alert"><span>{error}</span>{/成本预算|秒预算|BUDGET_EXCEEDED/.test(error) && <button type="button" className="button outline small" onClick={() => openSettings('runtime')}>调整运行预算</button>}</div>}
        </section> : <div className="no-session"><strong>创建一个会话开始工作</strong><button className="button primary" onClick={newSession}>新建会话</button></div>}
      </div>
      {currentSession && <AgentInputBar
        project={currentProject} activeFilePath={activeFilePath} projects={projectList} onSelectProject={(id) => void associateProject(id)} gitBusy={gitBusy} onInitGit={() => void initGit()} approvalMode={approvalMode} onOpenSettings={() => openSettings()} value={currentSession.prompt} inputRef={promptInputRef}
        hasMessages={currentSession.messages.length > 0} busy={isLoading} running={isCurrentRunning} editing={Boolean(editingMessageId)}
        onChange={(prompt) => updateCurrent({ prompt })} onKeyDown={handleKeyDown} onSend={() => void execute()} onStop={() => void cancelRun()}
        onCancelEdit={cancelMessageEdit}
        verificationMode={verificationMode} onVerificationModeChange={setVerificationMode}
        planningMode={planningMode} onPlanningModeChange={setPlanningMode}
        sessionRules={sessionRules} onSessionRulesChange={setSessionRules}
        multiModel={currentSession.multiModel !== false}
        pinnedModelId={currentSession.multiModel === false ? selectedSessionModelId : undefined}
        models={enabledModelOptions}
        onToggleMultiModel={toggleMultiModel}
        onSelectModel={selectSessionModel}
      />}
    </main>}
    {view === 'workspace' && projectDrawerOpen && <button className="panel-backdrop inspector-backdrop" aria-label="关闭项目面板" onClick={() => setProjectDrawerOpen(false)} />}
    {view === 'workspace' && projectDrawerOpen && <WorkspacePanel project={currentProject} reloadKey={projectReloadKey} activePath={activeFilePath} onPreview={openFile} onChangeDirectory={() => setShowNewProject(true)} />}
    {showSettings && <Settings models={models} onClose={() => setShowSettings(false)} onModelsChanged={setModels} onOpenRouting={() => setShowRouting(true)} initialTab={settingsInitialTab} />}
    {showRouting && <RoutingPanel onClose={() => setShowRouting(false)} />}
    {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} onCreated={handleProjectCreated} />}
  </div>;
}

