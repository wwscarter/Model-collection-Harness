import React, { useEffect, useRef, useState } from 'react';
import type { RunTrace, SessionMetrics, BudgetLimitNotice } from '../types';
import { appendAssistantChunk, type ChatAgentMessage, historyForModel, preparePendingTurn, setLatestAssistantDuration, settleAssistantTools, stripAssistantProcess, type ToolCallUpdate, updateAssistantAgent, updateLatestAssistantAttribution, updateLatestAssistantContent, upsertAssistantTool } from '../sessionMessages';
import { completeSessionMetrics, type SessionRunTiming } from '../sessionMetrics';
import { errorMessage } from '../format';
import { shouldSubmitPromptKey } from '../promptKeyboard';
import type { Session } from './sessionState';
import { useSessionState } from './useSessionState';
import type { SessionVerificationEvent, VerificationMode } from '../verificationTypes';
import type { PlanningMode } from '@core/planning/PlanTypes';
import { useSessionPlans } from './useSessionPlans';

/** Owns one active run and folds its IPC events into the session snapshots. */
export function useSessionRun() {
  const state = useSessionState();
  const plans = useSessionPlans(state.currentSessionId ?? undefined);
  const [planningMode, setPlanningMode] = useState<PlanningMode>();
  const {
    sessionsRef, setSessions, deletedSessionIdsRef, saveSession, cancelRequestedRef,
    currentSession, isLoading, selectedSessionModelId, editingMessageId, setEditingMessageId,
    setSessionError, runningSessionId, setRunningSessionId, promptBeforeEditingRef,
    cancelMessageEdit,
  } = state;
  const [completionNotice, setCompletionNotice] = useState(false);
  const [projectReloadKey, setProjectReloadKey] = useState(0);
  const [liveTrace, setLiveTrace] = useState<RunTrace>();
  const currentRunIdRef = useRef<string | undefined>(undefined);
  const includeProjectContext = true;
  const runTimingRef = useRef<SessionRunTiming | null>(null);
  const [liveElapsedMs, setLiveElapsedMs] = useState(0);
  const [verificationMode, setVerificationModeState] = useState<VerificationMode>('quick');
  const [verificationEvents, setVerificationEvents] = useState<Record<string, SessionVerificationEvent>>({});
  const [sessionRuleDrafts, setSessionRuleDrafts] = useState<Record<string, string>>({});
  const sessionRules = state.currentSessionId ? sessionRuleDrafts[state.currentSessionId] ?? '' : '';
  const setSessionRules = (content: string) => {
    if (isLoading || !state.currentSessionId) return;
    let bounded = content.slice(0, 8_000);
    if (/[\uD800-\uDBFF]/.test(bounded.at(-1) ?? '')) bounded = bounded.slice(0, -1);
    setSessionRuleDrafts((current) => ({ ...current, [state.currentSessionId!]: bounded }));
  };
  const setVerificationMode = (mode: VerificationMode) => { if (!isLoading) setVerificationModeState(mode); };
  const withRunTiming = (metrics: SessionMetrics | undefined, sessionId: string, confidence: number | undefined, hasOutput: boolean, stopReason?: string): SessionMetrics | undefined => {
    const timing = runTimingRef.current;
    const source = stopReason === undefined ? metrics : { ...metrics, stopReason };
    return completeSessionMetrics(source, timing?.sessionId === sessionId ? timing : undefined, confidence, hasOutput, performance.now());
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
    const unsubscribeVerification = window.amd?.on('session:verification', (payload) => {
      const event = payload as SessionVerificationEvent;
      if (!event.sessionId || !['checking', 'repair', 'completed'].includes(event.phase) || deletedSessionIdsRef.current.has(event.sessionId)) return;
      const session = sessionsRef.current.find((candidate) => candidate.id === event.sessionId);
      const latest = session?.messages.slice().reverse().find((message) => message.role === 'assistant');
      if (!session || !latest || (event.assistantMessageId && latest.id !== event.assistantMessageId)) return;
      setVerificationEvents((existing) => ({ ...existing, [event.sessionId]: event }));
      if (event.phase === 'repair') {
        setSessions((existing) => existing.map((candidate) => candidate.id !== event.sessionId ? candidate : {
          ...candidate, output: '', messages: candidate.messages.map((message) => message.id === latest.id ? { ...message, content: '' } : message),
        }));
      }
    });
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
      const event = payload as { sessionId?: string; taskId?: string; runId?: string; output?: string; stopReason?: string; modelUsed?: string | { id?: string; name?: string }; planningModelId?: string; decision?: { confidence?: number }; metrics?: SessionMetrics; budgetLimit?: BudgetLimitNotice };
      const id = event.sessionId || event.taskId;
      if (!id || deletedSessionIdsRef.current.has(id)) return;
      const modelUsed = typeof event.modelUsed === 'string' ? event.modelUsed : event.modelUsed?.id || event.modelUsed?.name;
      const stopReason = event.stopReason ?? event.metrics?.stopReason ?? sessionsRef.current.find((session) => session.id === id)?.metrics?.stopReason;
      const sourceMetrics = event.metrics ?? sessionsRef.current.find((session) => session.id === id)?.metrics;
      const metrics = withRunTiming(event.budgetLimit ? { ...sourceMetrics, budgetLimit: event.budgetLimit } : sourceMetrics, id, event.decision?.confidence, Boolean(event.output), stopReason);
      setSessions((existing) => existing.map((session) => {
        if (session.id !== id) return session;
        let messages = updateLatestAssistantContent(session.messages, event.output ?? '', modelUsed, event.planningModelId);
        if (metrics?.latencyMs !== undefined) messages = setLatestAssistantDuration(messages, metrics.latencyMs);
        return { ...session, messages, output: event.output ?? '', modelUsed, runId: event.runId ?? session.runId, routeConfidence: metrics?.routeConfidence, metrics };
      }));
      setCompletionNotice(true);
    });
    return () => { unsubscribeVerification?.(); unsubscribeChunk?.(); unsubscribeModel?.(); unsubscribeAgent?.(); unsubscribeTool?.(); unsubscribeTrace?.(); unsubscribe?.(); };
  }, []);

  const execute = async () => {
    // Enter bypasses the disabled send button, so guard here too.
    if (!currentSession || !currentSession.prompt.trim() || isLoading || deletedSessionIdsRef.current.has(currentSession.id)) return;
    const pinnedModelId = currentSession.multiModel === false ? selectedSessionModelId : undefined;
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
    setVerificationEvents((existing) => { const next = { ...existing }; delete next[currentSession.id]; return next; });
    promptBeforeEditingRef.current = '';
    setEditingMessageId(null);
    setSessionError(null);
    setRunningSessionId(currentSession.id);
    setSessions((existing) => existing.map((session) => session.id === currentSession.id ? submittedSession : session));
    try {
      if (!window.amd) throw new Error('主进程尚未连接，请在 Electron 中运行应用。');
      await saveSession(submittedSession);
      if (deletedSessionIdsRef.current.has(currentSession.id)) return;
      if (cancelRequestedRef.current) throw new Error('任务已取消');
      // 流式执行，不等待完全完成 - 由事件监听器处理结果
      const result = await window.amd.sessions.execute({
        sessionId: currentSession.id,
        projectId: currentSession.projectId ?? null,
        taskId: currentSession.id,
        runId,
        assistantMessageId: `${messageId}-assistant`,
        prompt,
        taskType: 'general',
        stream: true,
        includeProjectContext,
        verificationMode,
        planningMode,
        sessionRules: sessionRules.trim() ? sessionRules : undefined,
        pinnedModelId,
        // Earlier turns of this conversation (the pending user/assistant pair is the last two).
        history: historyForModel(messages.slice(0, -2)),
      });
      if (deletedSessionIdsRef.current.has(currentSession.id)) return;
      const latestSession = sessionsRef.current.find((session) => session.id === currentSession.id);
      if (!latestSession) return;
      const raw = result as any;
      const modelUsed = typeof raw.modelUsed === 'string' ? raw.modelUsed : raw.modelUsed?.id || raw.modelUsed?.name;
      const output = String(raw.output || '');
      const sourceMetrics = raw.metrics ?? latestSession.metrics;
      const metrics = withRunTiming(raw.budgetLimit ? { ...sourceMetrics, budgetLimit: raw.budgetLimit } : sourceMetrics, currentSession.id, raw.decision?.confidence, Boolean(output), raw.stopReason ?? raw.metrics?.stopReason ?? latestSession.metrics?.stopReason);
      let completedMessages = updateLatestAssistantContent(latestSession.messages, output, modelUsed, raw.planningModelId);
      const elapsedMs = metrics?.latencyMs ?? (runTimingRef.current?.sessionId === currentSession.id ? performance.now() - runTimingRef.current.startedAt : undefined);
      if (elapsedMs !== undefined) completedMessages = setLatestAssistantDuration(completedMessages, elapsedMs);
      const persistedMessages = stripAssistantProcess(completedMessages);
      const completedSession: Session = { ...latestSession, messages: persistedMessages, output, modelUsed, runId: raw.runId ?? runId, routeConfidence: metrics?.routeConfidence, metrics, audit: raw.audit, auditResult: raw.audit, taskType: raw.decision?.taskType, updatedAt: new Date() };
      setSessions((existing) => existing.map((session) => session.id === currentSession.id ? completedSession : session));
      await saveSession(completedSession);
    } catch (cause) {
      if (deletedSessionIdsRef.current.has(currentSession.id)) return;
      setVerificationEvents((existing) => {
        const event = existing[currentSession.id];
        return !event || event.phase === 'completed' ? existing : { ...existing, [currentSession.id]: { ...event, phase: 'completed', status: /取消/.test(errorMessage(cause)) ? 'cancelled' : 'failed', summary: errorMessage(cause) } };
      });
      setSessionError({ sessionId: currentSession.id, message: errorMessage(cause) });
      const latestSession = sessionsRef.current.find((session) => session.id === currentSession.id);
      if (latestSession) {
        const settledMessages = settleAssistantTools(latestSession.messages, `${messageId}-assistant`).map((message) => message.id !== `${messageId}-assistant` || !message.agents ? message : {
          ...message,
          agents: message.agents.map((agent) => agent.status === 'queued' || agent.status === 'running' ? { ...agent, status: 'failed' as const, error: errorMessage(cause) } : agent),
        });
        const failedSession: Session = { ...latestSession, runId, messages: stripAssistantProcess(settledMessages), updatedAt: new Date() };
        setSessions((existing) => existing.map((session) => session.id === currentSession.id ? failedSession : session));
        try { await saveSession(failedSession); }
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
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSubmitPromptKey(event.nativeEvent)) {
      event.preventDefault();
      void execute();
    } else if (event.key === 'Escape' && editingMessageId) {
      event.preventDefault();
      cancelMessageEdit();
    }
  };

  return {
    ...state, completionNotice, setCompletionNotice, projectReloadKey, setProjectReloadKey,
    liveTrace, liveElapsedMs, execute, cancelRun, handleKeyDown,
    verificationMode, setVerificationMode, currentVerification: state.currentSessionId ? verificationEvents[state.currentSessionId] : undefined,
    sessionRules, setSessionRules,
    ...plans, planningMode, setPlanningMode,
  };
}

export type SessionRun = ReturnType<typeof useSessionRun>;
