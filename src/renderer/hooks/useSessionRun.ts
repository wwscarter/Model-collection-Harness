import React, { useEffect, useRef, useState } from 'react';
import type { RunTrace, SessionMetrics, BudgetLimitNotice, ProcessSummary } from '../types';
import { type ChatMessage, type ChatAgentMessage, historyForModel, preparePendingTurn, setLatestAssistantDuration, settleAssistantTools, settleAssistantActivity, stripAssistantProcess, type ToolCallUpdate, updateAssistantAgent, updateAssistantMedia, updateAssistantAttribution, mergeAssistantAgents, upsertAssistantAgentTool, upsertAssistantTool } from '../sessionMessages';
import { normalizeExecutionAttempts, type ExecutionAttempt } from '@core/agent/RunActivity';
import { completeSessionMetrics, type SessionRunTiming } from '../sessionMetrics';
import { errorMessage } from '../format';
import { shouldSubmitPromptKey } from '../promptKeyboard';
import type { Session } from './sessionState';
import { useSessionState } from './useSessionState';
import type { SessionVerificationEvent, VerificationMode } from '../verificationTypes';
import type { PlanningMode } from '@core/planning/PlanTypes';
import { useSessionPlans } from './useSessionPlans';

type TurnIdentity = { assistantMessageId?: string; runId?: string };
function eventMessage(session: Session, event: TurnIdentity): ChatMessage | undefined {
  const target = event.assistantMessageId ? session.messages.find((message) => message.role === 'assistant' && message.id === event.assistantMessageId)
    : event.runId ? [...session.messages].reverse().find((message) => message.role === 'assistant' && message.runId === event.runId)
    : [...session.messages].reverse().find((message) => message.role === 'assistant');
  if (target && event.runId && target.runId && target.runId !== event.runId) return undefined;
  return target;
}
interface TurnResult extends TurnIdentity {
  output?: string; modelUsed?: string | { id?: string; name?: string; modelId?: string };
  actualModelId?: string;
  planningModelId?: string; agentMessages?: unknown; executionAttempts?: unknown; artifacts?: unknown[];
}
function mergeTurnResult(messages: ChatMessage[], targetId: string, result: TurnResult): ChatMessage[] {
  const modelUsed = typeof result.modelUsed === 'string' ? result.modelUsed : result.modelUsed?.id || result.modelUsed?.name;
  const actualModelId = result.actualModelId ?? (typeof result.modelUsed === 'object' ? result.modelUsed?.modelId : undefined);
  let next = messages.map((message) => message.id === targetId && message.role === 'assistant' ? { ...message, content: result.output ?? '' } : message);
  for (const attempt of normalizeExecutionAttempts(result.executionAttempts)) next = updateAssistantAttribution(next, { messageId: targetId, runId: result.runId, modelUsed: attempt.modelId, actualModelId: attempt.actualModelId, attempt });
  next = updateAssistantAttribution(next, { messageId: targetId, runId: result.runId, modelUsed, actualModelId, planningModelId: result.planningModelId });
  next = mergeAssistantAgents(next, targetId, result.agentMessages);
  next = updateAssistantMedia(next, { messageId: targetId, artifacts: result.artifacts });
  return settleAssistantActivity(next, targetId, 'completed');
}

/** Owns one active run and folds its IPC events into the session snapshots. */
export function useSessionRun(options: { startFresh?: boolean } = {}) {
  const state = useSessionState(options);
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
  const [canceledProcesses, setCanceledProcesses] = useState<ProcessSummary[]>([]);
  const currentRunIdRef = useRef<string | undefined>(undefined);
  const finishedMessageIdsRef = useRef(new Set<string>());
  const finishMessage = (messageId: string) => {
    const finished = finishedMessageIdsRef.current;
    finished.add(messageId);
    if (finished.size > 1000) finished.delete(finished.values().next().value!);
  };
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
      const event = payload as TurnIdentity & { sessionId?: string; taskId?: string; delta?: string };
      const id = event.sessionId || event.taskId;
      if (!id || !event.delta || deletedSessionIdsRef.current.has(id)) return;
      const session = sessionsRef.current.find((candidate) => candidate.id === id);
      const target = session && eventMessage(session, event);
      if (!target || finishedMessageIdsRef.current.has(target.id) || (event.runId && event.runId !== currentRunIdRef.current)) return;
      const timing = runTimingRef.current;
      if (timing?.sessionId === id && timing.completedAt !== undefined) return;
      if (timing?.sessionId === id && timing.ttftMs === undefined) timing.ttftMs = performance.now() - timing.startedAt;
      setSessions((existing) => existing.map((candidate) => {
        if (candidate.id !== id) return candidate;
        const messages = candidate.messages.map((message) => message.id === target.id ? { ...message, content: message.content + event.delta } : message);
        return { ...candidate, messages, output: messages.slice().reverse().find((message) => message.role === 'assistant')?.content || '' };
      }));
    });
    const unsubscribeModel = window.amd?.on('session:model-switched', (payload) => {
      const event = payload as TurnIdentity & { sessionId?: string; taskId?: string; modelId?: string; actualModelId?: string; attempt?: ExecutionAttempt; role?: 'routing' | 'planning' | 'execution' | 'orchestrator'; planningModelId?: string; confidence?: number };
      const id = event.sessionId || event.taskId;
      if (!id || !event.modelId || deletedSessionIdsRef.current.has(id)) return;
      setSessions((existing) => existing.map((session) => {
        if (session.id !== id) return session;
        const target = eventMessage(session, event);
        if (!target || finishedMessageIdsRef.current.has(target.id)) return session;
        const latest = [...session.messages].reverse().find((message) => message.role === 'assistant')?.id === target.id;
        const timing = runTimingRef.current;
        if (latest && timing?.sessionId === id && event.confidence !== undefined) timing.routeConfidence = event.confidence;
        if (event.role === 'routing') return latest ? { ...session, routeConfidence: event.confidence } : session;
        if (event.role === 'planning') return { ...session, messages: updateAssistantAttribution(session.messages, { messageId: target.id, runId: event.runId, planningModelId: event.modelId }) };
        if (event.role === 'execution' || event.role === 'orchestrator') {
          const messages = updateAssistantAttribution(session.messages, { messageId: target.id, runId: event.runId, modelUsed: event.modelId, actualModelId: event.actualModelId, planningModelId: event.planningModelId, attempt: event.attempt });
          return { ...session, messages, ...(latest ? { modelUsed: messages.find((message) => message.id === target.id)?.modelUsed, routeConfidence: event.confidence ?? session.routeConfidence } : {}) };
        }
        return session;
      }));
    });
    const unsubscribeAgent = window.amd?.on('session:agent-update', (payload) => {
      const event = payload as Partial<ChatAgentMessage> & TurnIdentity & { sessionId?: string; agentId?: string; delta?: string };
      if (!event.sessionId || !event.assistantMessageId || !event.agentId || deletedSessionIdsRef.current.has(event.sessionId) || finishedMessageIdsRef.current.has(event.assistantMessageId)) return;
      setSessions((existing) => existing.map((session) => session.id === event.sessionId && eventMessage(session, event) ? {
        ...session, messages: updateAssistantAgent(session.messages, event.assistantMessageId!, { ...event, agentId: event.agentId! }),
      } : session));
    });
    const unsubscribeTool = window.amd?.on('session:tool-call', (payload) => {
      const event = payload as Partial<ToolCallUpdate> & TurnIdentity & { sessionId?: string; agentId?: string };
      if (!event.sessionId || !event.assistantMessageId || !event.toolCallId || !event.toolName || !event.status || deletedSessionIdsRef.current.has(event.sessionId) || finishedMessageIdsRef.current.has(event.assistantMessageId)) return;
      if (event.status === 'completed' && ['write', 'edit', 'run_command'].includes(event.toolName)) setProjectReloadKey((key) => key + 1);
      setSessions((existing) => existing.map((session) => session.id === event.sessionId && eventMessage(session, event) ? {
        ...session, messages: event.agentId
          ? upsertAssistantAgentTool(session.messages, event.assistantMessageId!, event.agentId, event as ToolCallUpdate)
          : upsertAssistantTool(session.messages, event.assistantMessageId!, event as ToolCallUpdate),
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
    const applyMediaEvent = (payload: unknown) => {
      const event = payload as { sessionId?: string; assistantMessageId?: string; runId?: string; job?: unknown; artifact?: unknown; artifacts?: unknown[] };
      if (!event.sessionId || !event.assistantMessageId || deletedSessionIdsRef.current.has(event.sessionId)) return;
      setSessions((existing) => existing.map((session) => session.id !== event.sessionId ? session : {
        ...session, messages: updateAssistantMedia(session.messages, { messageId: event.assistantMessageId, job: event.job, artifacts: event.artifacts ?? (event.artifact ? [event.artifact] : []) }),
      }));
    };
    const unsubscribeMediaJob = window.amd?.on('session:media-job', applyMediaEvent);
    const unsubscribeMediaArtifact = window.amd?.on('session:media-artifact', applyMediaEvent);
    const unsubscribe = window.amd?.on('session:completed', (payload) => {
      const event = payload as TurnResult & { sessionId?: string; taskId?: string; stopReason?: string; decision?: { confidence?: number }; metrics?: SessionMetrics; budgetLimit?: BudgetLimitNotice };
      const id = event.sessionId || event.taskId;
      if (!id || deletedSessionIdsRef.current.has(id)) return;
      const source = sessionsRef.current.find((session) => session.id === id);
      const target = source && eventMessage(source, event);
      if (!source || !target || finishedMessageIdsRef.current.has(target.id)) return;
      const latest = [...source.messages].reverse().find((message) => message.role === 'assistant')?.id === target.id;
      const stopReason = event.stopReason ?? event.metrics?.stopReason ?? source.metrics?.stopReason;
      const sourceMetrics = event.metrics ?? source.metrics;
      const metrics = latest ? withRunTiming(event.budgetLimit ? { ...sourceMetrics, budgetLimit: event.budgetLimit } : sourceMetrics, id, event.decision?.confidence, Boolean(event.output), stopReason) : undefined;
      setSessions((existing) => existing.map((session) => {
        if (session.id !== id) return session;
        let messages = mergeTurnResult(session.messages, target.id, event);
        if (metrics?.latencyMs !== undefined) messages = setLatestAssistantDuration(messages, metrics.latencyMs, target.id);
        const modelUsed = messages.find((message) => message.id === target.id)?.modelUsed;
        return { ...session, messages, ...(latest ? { output: event.output ?? '', modelUsed, runId: event.runId ?? session.runId, routeConfidence: metrics?.routeConfidence, metrics } : {}) };
      }));
      finishMessage(target.id);
      if (latest) setCompletionNotice(true);
    });
    return () => { unsubscribeVerification?.(); unsubscribeChunk?.(); unsubscribeModel?.(); unsubscribeAgent?.(); unsubscribeTool?.(); unsubscribeTrace?.(); unsubscribeMediaJob?.(); unsubscribeMediaArtifact?.(); unsubscribe?.(); };
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
    const messages = preparePendingTurn(currentSession.messages, messageId, prompt, editingMessageId ?? undefined).map((message) => message.id === messageId + '-assistant' ? { ...message, runId } : message);
    const submittedSession: Session = { ...currentSession, prompt: '', userMessage: prompt, output: '', messages, title, runId, metrics: undefined, modelUsed: undefined, routeConfidence: undefined, audit: undefined, auditResult: undefined, rating: undefined, updatedAt: new Date() };
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
        textModelPreferenceId: pinnedModelId,
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
      let completedMessages = mergeTurnResult(latestSession.messages, messageId + '-assistant', { ...raw, output, runId: raw.runId ?? runId });
      const elapsedMs = metrics?.latencyMs ?? (runTimingRef.current?.sessionId === currentSession.id ? performance.now() - runTimingRef.current.startedAt : undefined);
      if (elapsedMs !== undefined) completedMessages = setLatestAssistantDuration(completedMessages, elapsedMs);
      finishMessage(messageId + '-assistant');
      const persistedMessages = stripAssistantProcess(completedMessages);
      const completedSession: Session = { ...latestSession, messages: persistedMessages, output, modelUsed: modelUsed ?? latestSession.modelUsed, runId: raw.runId ?? runId, routeConfidence: metrics?.routeConfidence, metrics, audit: raw.audit, auditResult: raw.audit, taskType: raw.decision?.taskType, updatedAt: new Date() };
      setSessions((existing) => existing.map((session) => session.id === currentSession.id ? completedSession : session));
      await saveSession(completedSession);
    } catch (cause) {
      finishMessage(messageId + '-assistant');
      if (deletedSessionIdsRef.current.has(currentSession.id)) return;
      setVerificationEvents((existing) => {
        const event = existing[currentSession.id];
        return !event || event.phase === 'completed' ? existing : { ...existing, [currentSession.id]: { ...event, phase: 'completed', status: /取消/.test(errorMessage(cause)) ? 'cancelled' : 'failed', summary: errorMessage(cause) } };
      });
      setSessionError({ sessionId: currentSession.id, message: errorMessage(cause) });
      const latestSession = sessionsRef.current.find((session) => session.id === currentSession.id);
      if (latestSession) {
        const cancelled = cancelRequestedRef.current || /取消/.test(errorMessage(cause));
        const settledMessages = settleAssistantActivity(settleAssistantTools(latestSession.messages, `${messageId}-assistant`), `${messageId}-assistant`, cancelled ? 'cancelled' : 'failed', errorMessage(cause));
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
    catch (cause) { setSessionError({ sessionId: runningSessionId, message: errorMessage(cause) }); return; }
    // Background services outlive the run by design; offer one explicit choice
    // instead of leaking them or killing a dev server the user wants to keep.
    try {
      const started = await window.amd?.processes.list(undefined, runningSessionId) ?? [];
      const alive = started.filter((process) => process.running);
      if (alive.length) setCanceledProcesses(alive);
    } catch { /* Listing is best effort; the run is already cancelled. */ }
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
    liveTrace, liveElapsedMs, execute, cancelRun, handleKeyDown, canceledProcesses, setCanceledProcesses,
    verificationMode, setVerificationMode, currentVerification: state.currentSessionId ? verificationEvents[state.currentSessionId] : undefined,
    sessionRules, setSessionRules,
    ...plans, planningMode, setPlanningMode,
  };
}

export type SessionRun = ReturnType<typeof useSessionRun>;
