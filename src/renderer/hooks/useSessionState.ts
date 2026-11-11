import React, { useEffect, useRef, useState } from 'react';
import type { ModelConfig, SessionMetrics } from '../types';
import { restoreMessages, type ChatMessage } from '../sessionMessages';
import { restoreRouteConfidence } from '../sessionMetrics';
import { errorMessage } from '../format';
import { starterSession, type Session } from './sessionState';
import { supportsOperation } from '@core/models/ModelOperations';

/** Synchronous session snapshots keep IPC callbacks and persistence in agreement. */
export function useSessionState() {
  const [sessions, setSessionsState] = useState<Session[]>([starterSession()]);
  // IPC events can arrive immediately before execute rejects. Keep their latest
  // state available synchronously so a failed/cancelled turn is saved in full.
  const sessionsRef = useRef(sessions);
  const setSessions = (update: React.SetStateAction<Session[]>) => {
    const next = typeof update === 'function' ? update(sessionsRef.current) : update;
    sessionsRef.current = next;
    setSessionsState(next);
  };
  const deletedSessionIdsRef = useRef(new Set<string>());
  const pendingSessionSavesRef = useRef(new Map<string, Set<Promise<unknown>>>());
  const saveSession = (session: Session): Promise<unknown> => {
    if (deletedSessionIdsRef.current.has(session.id)) return Promise.resolve();
    const pending = Promise.resolve().then(() => {
      if (!deletedSessionIdsRef.current.has(session.id)) return window.amd?.sessions.save(session);
    });
    const saves = pendingSessionSavesRef.current.get(session.id) ?? new Set<Promise<unknown>>();
    saves.add(pending);
    pendingSessionSavesRef.current.set(session.id, saves);
    const settled = () => {
      saves.delete(pending);
      if (!saves.size) pendingSessionSavesRef.current.delete(session.id);
    };
    void pending.then(settled, settled);
    return pending;
  };
  const cancelRequestedRef = useRef(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<{ sessionId: string; message: string } | null>(null);
  const persistSession = (session: Session) => {
    void saveSession(session).catch((cause) => {
      if (!deletedSessionIdsRef.current.has(session.id)) setSessionError({ sessionId: session.id, message: `会话保存失败：${errorMessage(cause)}` });
    });
  };
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const promptBeforeEditingRef = useRef('');
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
  const bannerModels = [modelLabel(latestAssistant?.planningModelId), latestAssistant?.actualModelId ?? modelLabel(latestAssistant?.modelUsed ?? currentSession?.modelUsed)].filter(Boolean).join(' + ') || '自动调度';
  useEffect(() => {
    setEditingMessageId(null);
    promptBeforeEditingRef.current = '';
  }, [currentSessionId]);

  useEffect(() => {
    let active = true;
    // 预加载模型列表，避免第一次执行时的延迟
    const loadModels = async () => {
      try {
        const modelList = await window.amd?.models.list();
        if (active && modelList) setModels(modelList);
      } catch (error) {
        console.error('Failed to load models:', error);
      }
    };
    loadModels();
    if (!window.amd) setCurrentSessionId(sessions[0]?.id || null);

    void window.amd?.sessions.list().then((records) => {
      if (!active) return;
      const restored = records.map((record) => ({
        id: String(record.id), title: String(record.title || '未命名会话'), prompt: String(record.prompt || ''), userMessage: String(record.userMessage || ''), output: String(record.output || ''), messages: restoreMessages(record, { inactive: true }),
        modelUsed: record.modelUsed ? String(record.modelUsed) : undefined, runId: record.runId ? String(record.runId) : undefined, metrics: record.metrics as SessionMetrics | undefined,
        audit: record.auditResult as Session['audit'], auditResult: record.auditResult as Session['auditResult'],
        routeConfidence: restoreRouteConfidence(record),
        multiModel: record.multiModel !== false, modelId: record.modelId ? String(record.modelId) : undefined,
        projectId: record.projectId ? String(record.projectId) : undefined, projectRoot: record.projectRoot ? String(record.projectRoot) : undefined,
        rating: typeof record.rating === 'number' ? record.rating : undefined,
        createdAt: new Date(String(record.createdAt)), updatedAt: new Date(String(record.updatedAt || record.createdAt)),
      }));
      const localIds = new Set(sessionsRef.current.map((session) => session.id));
      const hasLocalChanges = currentSessionIdRef.current !== null || deletedSessionIdsRef.current.size > 0;
      const available = restored.filter((session) => !deletedSessionIdsRef.current.has(session.id));
      const next = hasLocalChanges ? [...sessionsRef.current, ...available.filter((session) => !localIds.has(session.id))] : available.length ? available : sessionsRef.current;
      setSessions(next);
      if (!currentSessionIdRef.current) {
        currentSessionIdRef.current = next[0]?.id || null;
        setCurrentSessionId(currentSessionIdRef.current);
      }
    }).catch((cause) => {
      if (!active) return;
      const id = currentSessionIdRef.current ?? sessionsRef.current[0]?.id ?? null;
      currentSessionIdRef.current = id; setCurrentSessionId(id);
      if (id) setSessionError({ sessionId: id, message: `会话读取失败：${errorMessage(cause)}` });
    });
    return () => { active = false; };
  }, []);

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
  const enabledModelOptions = models.filter((model) => model.enabled && supportsOperation(model, 'text.chat') && (model.hasApiKey || model.provider === 'custom'));
  const defaultSessionModelId = enabledModelOptions.find((model) => model.isPrimary)?.id ?? enabledModelOptions[0]?.id;
  const selectedSessionModelId = enabledModelOptions.some((model) => model.id === currentSession?.modelId) ? currentSession?.modelId : defaultSessionModelId;
  const saveSessionPreference = (patch: Partial<Session>) => {
    if (!currentSession) return;
    const latest = sessionsRef.current.find((session) => session.id === currentSession.id);
    if (!latest || deletedSessionIdsRef.current.has(latest.id)) return;
    const next = { ...latest, ...patch };
    updateCurrent(patch);
    persistSession({ ...next, updatedAt: new Date() });
  };
  const toggleMultiModel = () => {
    if (!currentSession) return;
    const multiModel = currentSession.multiModel === false;
    saveSessionPreference({ multiModel, ...(multiModel ? {} : { modelId: currentSession.modelId ?? defaultSessionModelId }) });
  };
  const selectSessionModel = (modelId: string) => saveSessionPreference({ modelId, multiModel: false });

  return {
    sessions, sessionsRef, setSessions, deletedSessionIdsRef, pendingSessionSavesRef,
    saveSession, persistSession, cancelRequestedRef, currentSessionId, currentSessionIdRef,
    setCurrentSessionId, models, setModels, runningSessionId, setRunningSessionId,
    sessionError, setSessionError, editingMessageId, setEditingMessageId,
    promptInputRef, promptBeforeEditingRef, currentSession, isLoading, isCurrentRunning,
    error, modelLabel, bannerModels, updateCurrent, startMessageEdit, cancelMessageEdit,
    enabledModelOptions, selectedSessionModelId, toggleMultiModel, selectSessionModel,
  };
}

export type SessionState = ReturnType<typeof useSessionState>;
