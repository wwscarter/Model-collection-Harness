import { normalizeAgents, normalizeActivityTools, normalizeExecutionAttempts, type ActivityTool, type AgentActivity, type ExecutionAttempt } from '@core/agent/RunActivity';
import { normalizeArtifacts, normalizeMediaJobs, type MediaArtifact, type MediaJobSummary } from './mediaTypes';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  modelUsed?: string;
  runId?: string;
  actualModelId?: string;
  executionAttempts?: ExecutionAttempt[];
  planningModelId?: string;
  durationMs?: number;
  agents?: ChatAgentMessage[];
  tools?: ChatToolCall[];
  artifacts?: MediaArtifact[];
  mediaJobs?: MediaJobSummary[];
}

/** A tool call the model made while answering (web search, page fetch, file read). */
export interface ChatToolCall extends ActivityTool {}

export interface ToolCallUpdate {
  toolCallId: string;
  toolName: string;
  status: ChatToolCall['status'];
  args?: unknown;
  summary?: string;
  durationMs?: number;
}

export interface ChatAgentMessage extends AgentActivity {}

type SessionMessageSource = {
  messages?: unknown;
  userMessage?: unknown;
  prompt?: unknown;
  output?: unknown;
  title?: unknown;
};

export function restoreMessages(record: SessionMessageSource, options: { inactive?: boolean } = {}): ChatMessage[] {
  if (Array.isArray(record.messages)) {
    const messages = record.messages.flatMap((value, index): ChatMessage[] => {
      if (!value || typeof value !== 'object') return [];
      const message = value as Partial<ChatMessage>;
      if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') return [];
      return [{
        id: typeof message.id === 'string' ? message.id : `restored-${index}`,
        role: message.role,
        content: message.content,
        ...(typeof message.modelUsed === 'string' ? { modelUsed: message.modelUsed } : {}),
        ...(typeof message.runId === 'string' ? { runId: message.runId.slice(0, 300) } : {}),
        ...(typeof message.actualModelId === 'string' ? { actualModelId: message.actualModelId.slice(0, 300) } : {}),
        ...(Array.isArray(message.executionAttempts) ? { executionAttempts: normalizeExecutionAttempts(message.executionAttempts) } : {}),
        ...(typeof message.planningModelId === 'string' ? { planningModelId: message.planningModelId } : {}),
        ...(typeof message.durationMs === 'number' && Number.isFinite(message.durationMs) ? { durationMs: message.durationMs } : {}),
        ...(Array.isArray(message.agents) ? { agents: normalizeAgents(message.agents) } : {}),
        ...(Array.isArray(message.tools) ? { tools: restoreTools(message.tools) } : {}),
        ...(Array.isArray(message.artifacts) ? { artifacts: normalizeArtifacts(message.artifacts) } : {}),
        ...(Array.isArray(message.mediaJobs) ? { mediaJobs: normalizeMediaJobs(message.mediaJobs) } : {}),
      }];
    });
    if (messages.length) return options.inactive ? restoreInactiveActivity(messages) : messages;
  }

  const output = typeof record.output === 'string' ? record.output : '';
  const userMessage = typeof record.userMessage === 'string' ? record.userMessage : '';
  const prompt = typeof record.prompt === 'string' ? record.prompt : '';
  const title = typeof record.title === 'string' ? record.title : '';
  const previousInput = userMessage.trim() || prompt.trim() || (output ? title : '');
  const messages: ChatMessage[] = [];
  if (previousInput) messages.push({ id: 'legacy-user', role: 'user', content: previousInput });
  if (output) messages.push({ id: 'legacy-assistant', role: 'assistant', content: output });
  return messages;
}

/** A restored conversation has no live task; preserve evidence without showing stale spinners. */
function restoreInactiveActivity(messages: ChatMessage[]): ChatMessage[] {
  const error = '会话已恢复，未收到本次活动完成状态';
  const settleTools = (tools: ActivityTool[] | undefined) => tools?.map((tool) => tool.status === 'running' ? { ...tool, status: 'failed' as const } : tool);
  return messages.map((message) => message.role !== 'assistant' ? message : { ...message,
    ...(message.agents ? { agents: message.agents.map((agent) => ({ ...agent,
      ...(['queued', 'running'].includes(agent.status) ? { status: 'cancelled' as const, error } : {}),
      ...(agent.tools ? { tools: settleTools(agent.tools) } : {}),
    })) } : {}),
    ...(message.executionAttempts ? { executionAttempts: message.executionAttempts.map((attempt) => attempt.status === 'running' ? { ...attempt, status: 'cancelled' as const, error } : attempt) } : {}),
  });
}

export function appendAssistantChunk(messages: ChatMessage[], delta: string): ChatMessage[] {
  const lastIndex = messages.length - 1;
  const lastMessage = messages[lastIndex];
  if (lastMessage?.role === 'assistant') {
    return messages.map((message, index) => index === lastIndex ? { ...message, content: `${message.content}${delta}` } : message);
  }
  return [...messages, { id: `assistant-${Date.now()}`, role: 'assistant', content: delta }];
}

export function replaceLatestAssistant(messages: ChatMessage[], content: string, modelUsed?: string): ChatMessage[] {
  let lastAssistantIndex = messages.length - 1;
  while (lastAssistantIndex >= 0 && messages[lastAssistantIndex].role !== 'assistant') lastAssistantIndex -= 1;
  if (lastAssistantIndex < 0) {
    return [...messages, { id: `assistant-${Date.now()}`, role: 'assistant', content, ...(modelUsed ? { modelUsed } : {}) }];
  }
  return messages.map((message, index) => index === lastAssistantIndex
    ? { ...message, content, ...(modelUsed ? { modelUsed } : {}) }
    : message);
}

export function truncateHistoryAtEditedMessage(messages: ChatMessage[], messageId: string, content: string): ChatMessage[] | undefined {
  const messageIndex = messages.findIndex((message) => message.id === messageId && message.role === 'user');
  if (messageIndex < 0) return undefined;
  return [...messages.slice(0, messageIndex), { ...messages[messageIndex], content }];
}

export function preparePendingTurn(
  messages: ChatMessage[],
  messageId: string,
  content: string,
  editedMessageId?: string,
  collaboratorModels: Array<{ id: string; name: string }> = [],
): ChatMessage[] {
  const editedHistory = editedMessageId ? truncateHistoryAtEditedMessage(messages, editedMessageId, content) : undefined;
  const assistantMessage: ChatMessage = {
    id: `${messageId}-assistant`,
    role: 'assistant',
    content: '',
    ...(collaboratorModels.length ? { agents: collaboratorModels.map((model, index) => ({ id: `${messageId}-assistant-agent-${index + 1}`, modelId: model.id, modelName: model.name, status: 'queued' as const, content: '' })) } : {}),
  };
  if (editedHistory) return [...editedHistory, assistantMessage];
  return [...messages, { id: `${messageId}-user`, role: 'user', content }, assistantMessage];
}

const terminalActivity = (status: string): boolean => ['completed', 'failed', 'cancelled'].includes(status);

function mergeTools(existing: ActivityTool[] = [], incoming: ActivityTool[] = []): ActivityTool[] {
  const tools = new Map(existing.map((tool) => [tool.id, tool]));
  for (const tool of incoming) {
    const previous = tools.get(tool.id);
    if (previous && previous.status !== 'running' && tool.status === 'running') continue;
    tools.set(tool.id, { ...previous, ...tool });
  }
  return normalizeActivityTools([...tools.values()]);
}

function mergeAgent(previous: AgentActivity | undefined, incoming: Partial<AgentActivity> & { id: string }, delta?: string): AgentActivity | undefined {
  const stale = Boolean(previous && terminalActivity(previous.status) && (!incoming.status || ['queued', 'running'].includes(incoming.status)));
  const update = Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined));
  const candidate = {
    id: incoming.id, modelId: incoming.modelId ?? previous?.modelId ?? incoming.id, modelName: incoming.modelName ?? previous?.modelName ?? incoming.modelId ?? 'subagent',
    status: incoming.status ?? previous?.status ?? 'running', content: previous?.content ?? '', ...previous, ...update,
  } as AgentActivity;
  if (stale && previous) {
    candidate.status = previous.status; candidate.content = previous.content;
    candidate.error = previous.error; candidate.finishedAt = previous.finishedAt; candidate.durationMs = previous.durationMs; candidate.stopReason = previous.stopReason;
  } else {
    candidate.content = incoming.content !== undefined ? incoming.content : delta ? (previous?.content ?? '') + delta : previous?.content ?? '';
    if (incoming.status === 'completed' && incoming.error === undefined) delete candidate.error;
  }
  if (previous?.tools || incoming.tools) candidate.tools = mergeTools(previous?.tools, incoming.tools);
  return normalizeAgents([candidate])[0];
}

export function updateAssistantAgent(
  messages: ChatMessage[],
  messageId: string,
  update: Partial<Omit<AgentActivity, 'id'>> & { agentId: string; delta?: string },
): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== messageId || message.role !== 'assistant') return message;
    const agents = message.agents ?? [], existing = agents.find((agent) => agent.id === update.agentId);
    const { agentId, delta, ...fields } = update;
    const merged = mergeAgent(existing, { ...fields, id: agentId }, delta);
    if (!merged) return message;
    return { ...message, agents: normalizeAgents(existing ? agents.map((agent) => agent.id === agentId ? merged : agent) : [...agents, merged]) };
  });
}

/** Completion payloads repair missed live events without replaying report text. */
export function mergeAssistantAgents(messages: ChatMessage[], messageId: string, agents: unknown): ChatMessage[] {
  return normalizeAgents(agents).reduce((current, agent) => { const { id, ...fields } = agent; return updateAssistantAgent(current, messageId, { agentId: id, ...fields }); }, messages);
}

export function upsertAssistantAgentTool(messages: ChatMessage[], messageId: string, agentId: string, update: ToolCallUpdate): ChatMessage[] {
  const message = messages.find((item) => item.id === messageId && item.role === 'assistant');
  if (!message) return messages;
  const agent = message.agents?.find((item) => item.id === agentId);
  const previous = agent?.tools?.find((tool) => tool.id === update.toolCallId);
  const label = describeToolArgs(update.args) ?? previous?.label;
  const tool: ActivityTool = { id: update.toolCallId, toolName: update.toolName, status: update.status,
    ...(label ? { label } : {}), ...(update.summary === undefined ? {} : { summary: update.summary }), ...(update.durationMs === undefined ? {} : { durationMs: update.durationMs }) };
  // A terminal agent cannot acquire a newly running tool from a delayed event.
  if (agent && terminalActivity(agent.status) && tool.status === 'running') return messages;
  return updateAssistantAgent(messages, messageId, { agentId, tools: mergeTools(agent?.tools, [tool]) });
}

export function updateAssistantAttribution(messages: ChatMessage[], update: { messageId?: string; runId?: string; modelUsed?: string; actualModelId?: string; planningModelId?: string; attempt?: ExecutionAttempt }): ChatMessage[] {
  const target = update.messageId ?? [...messages].reverse().find((message) => message.role === 'assistant')?.id;
  return messages.map((message) => {
    if (message.role !== 'assistant' || message.id !== target || (message.runId && update.runId && message.runId !== update.runId)) return message;
    const attempts = new Map((message.executionAttempts ?? []).map((attempt) => [attempt.id, attempt]));
    const incoming = normalizeExecutionAttempts(update.attempt ? [update.attempt] : [])[0];
    const latestIndex = Math.max(-1, ...[...attempts.values()].map((attempt) => attempt.index));
    if (incoming) {
      const previous = attempts.get(incoming.id);
      if (!previous || !terminalActivity(previous.status) || incoming.status !== 'running') attempts.set(incoming.id, { ...previous, ...incoming });
    }
    const stale = incoming && incoming.index < latestIndex;
    return { ...message,
      ...(update.runId ? { runId: update.runId.slice(0, 300) } : {}),
      ...(!stale && update.modelUsed ? { modelUsed: update.modelUsed.slice(0, 300) } : {}),
      ...(!stale && update.actualModelId ? { actualModelId: update.actualModelId.slice(0, 300) } : {}),
      ...(update.planningModelId ? { planningModelId: update.planningModelId.slice(0, 300) } : {}),
      ...(incoming ? { executionAttempts: normalizeExecutionAttempts([...attempts.values()].sort((left, right) => left.index - right.index)) } : {}),
    };
  });
}

export function updateLatestAssistantAttribution(messages: ChatMessage[], update: { modelUsed?: string; planningModelId?: string }): ChatMessage[] {
  return updateAssistantAttribution(messages, update);
}

/** End only activities that are still pending; keep completed/error evidence intact. */
export function settleAssistantActivity(messages: ChatMessage[], messageId: string, status: 'completed' | 'failed' | 'cancelled', error?: string): ChatMessage[] {
  const finishedAt = new Date().toISOString();
  const settleTools = (tools: ActivityTool[] | undefined) => tools?.map((tool) => tool.status === 'running' ? { ...tool, status: 'failed' as const } : tool);
  const elapsed = (startedAt?: string) => startedAt && Number.isFinite(Date.parse(startedAt)) ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : undefined;
  return messages.map((message) => {
    if (message.id !== messageId || message.role !== 'assistant') return message;
    return { ...message,
      ...(message.tools ? { tools: settleTools(message.tools) } : {}),
      ...(message.agents ? { agents: message.agents.map((agent) => {
        const tools = agent.tools ? { tools: settleTools(agent.tools) } : {};
        if (terminalActivity(agent.status)) return { ...agent, ...tools };
        const agentStatus = status === 'completed' ? 'failed' as const : status;
        const agentError = error ?? (status === 'completed' ? '本轮已结束，未收到完成状态' : undefined);
        return { ...agent, status: agentStatus, finishedAt, ...(elapsed(agent.startedAt) === undefined ? {} : { durationMs: elapsed(agent.startedAt) }), ...(agentError ? { error: agentError } : {}), ...tools };
      }) } : {}),
      ...(message.executionAttempts ? { executionAttempts: message.executionAttempts.map((attempt) => terminalActivity(attempt.status) ? attempt : { ...attempt, status, finishedAt, durationMs: elapsed(attempt.startedAt), ...(error ? { error } : {}) }) } : {}),
    };
  });
}

export function setLatestAssistantDuration(messages: ChatMessage[], durationMs: number, messageId?: string): ChatMessage[] {
  const target = messageId ?? [...messages].reverse().find((message) => message.role === 'assistant')?.id;
  return messages.map((message) => message.id === target && message.role === 'assistant' ? { ...message, durationMs } : message);
}

/** Address the original turn so delayed media events cannot attach to a newer reply. */
export function updateAssistantMedia(messages: ChatMessage[], update: { messageId?: string; artifacts?: unknown; job?: unknown }): ChatMessage[] {
  const target = update.messageId ?? [...messages].reverse().find((message) => message.role === 'assistant')?.id;
  const artifacts = normalizeArtifacts(update.artifacts);
  const jobs = normalizeMediaJobs(update.job ? [update.job] : []);
  return messages.map((message) => {
    if (message.role !== 'assistant' || message.id !== target) return message;
    const mergedArtifacts = new Map((message.artifacts ?? []).map((item) => [item.id, item]));
    for (const artifact of artifacts) mergedArtifacts.set(artifact.id, artifact);
    const mergedJobs = new Map((message.mediaJobs ?? []).map((item) => [item.id, item]));
    for (const job of jobs) {
      const previous = mergedJobs.get(job.id);
      if (previous?.status === 'succeeded' && job.status !== 'succeeded') continue;
      mergedJobs.set(job.id, job);
    }
    return { ...message, ...(mergedArtifacts.size ? { artifacts: [...mergedArtifacts.values()] } : {}), ...(mergedJobs.size ? { mediaJobs: [...mergedJobs.values()] } : {}) };
  });
}

/** Main tool rows remain transient; agent details and execution identity are durable. */
export function stripAssistantProcess(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    const { tools: _tools, ...final } = message;
    return final;
  });
}

export function updateLatestAssistantContent(messages: ChatMessage[], content: string, modelUsed?: string, planningModelId?: string): ChatMessage[] {
  let messageIndex = messages.length - 1;
  while (messageIndex >= 0 && messages[messageIndex].role !== 'assistant') messageIndex -= 1;
  if (messageIndex < 0) return [...messages, { id: `assistant-${Date.now()}`, role: 'assistant', content, ...(modelUsed ? { modelUsed } : {}), ...(planningModelId ? { planningModelId } : {}) }];
  return messages.map((message, index) => index === messageIndex ? {
    ...message,
    content,
    ...(modelUsed ? { modelUsed } : {}),
    ...(planningModelId ? { planningModelId } : {}),
  } : message);
}

const TOOL_LABEL_KEYS = ['query', 'url', 'path', 'command', 'processId'];

/** One-line description of what a tool call was asked to do, e.g. the search query or URL. */
export function describeToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  for (const key of TOOL_LABEL_KEYS) if (typeof record[key] === 'string' && record[key]) return (record[key] as string).slice(0, 300);
  return undefined;
}

/** Insert or update a tool call on the assistant message, keeping the order calls started in. */
export function upsertAssistantTool(messages: ChatMessage[], messageId: string, update: ToolCallUpdate): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== messageId || message.role !== 'assistant') return message;
    const tools = message.tools ?? [];
    const existing = tools.find((tool) => tool.id === update.toolCallId);
    const label = describeToolArgs(update.args) ?? existing?.label;
    const next: ChatToolCall = {
      id: update.toolCallId,
      toolName: update.toolName,
      status: update.status,
      ...(label ? { label } : {}),
      ...(update.summary ?? existing?.summary ? { summary: update.summary ?? existing?.summary } : {}),
      ...(update.durationMs ?? existing?.durationMs) !== undefined ? { durationMs: update.durationMs ?? existing?.durationMs } : {},
    };
    return { ...message, tools: existing ? tools.map((tool) => tool.id === update.toolCallId ? next : tool) : [...tools, next] };
  });
}

/** Tool calls still marked running when a turn ends (error or cancel) are shown as failed. */
export function settleAssistantTools(messages: ChatMessage[], messageId: string): ChatMessage[] {
  return messages.map((message) => message.id !== messageId || !message.tools?.some((tool) => tool.status === 'running') ? message : {
    ...message,
    tools: message.tools.map((tool) => tool.status === 'running' ? { ...tool, status: 'failed' as const } : tool),
  });
}

/** Completed user/assistant turns sent to the model as conversation history. */
export interface ModelHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  tools?: Array<{ name: string; status?: string; label?: string; summary?: string }>;
}

export function historyForModel(messages: ChatMessage[]): ModelHistoryTurn[] {
  return messages.filter((message) => message.content.trim() || message.artifacts?.length).map((message) => ({
    role: message.role,
    content: [message.content, ...(message.artifacts ?? []).map((artifact) => '已生成' + (artifact.kind === 'image' ? '图片' : '视频') + '，资产 ID：' + artifact.id + '；模型：' + artifact.modelId)].filter(Boolean).join('\n'),
    ...(message.tools?.length ? {
      tools: message.tools.map((tool) => ({ name: tool.toolName, status: tool.status, label: tool.label, summary: tool.summary })),
    } : {}),
  }));
}

function restoreTools(values: unknown[]): ChatToolCall[] {
  return values.flatMap((value): ChatToolCall[] => {
    if (!value || typeof value !== 'object') return [];
    const tool = value as Partial<ChatToolCall>;
    if (typeof tool.id !== 'string' || typeof tool.toolName !== 'string') return [];
    if (tool.status !== 'running' && tool.status !== 'completed' && tool.status !== 'failed') return [];
    return [{
      id: tool.id, toolName: tool.toolName, status: tool.status === 'running' ? 'failed' : tool.status,
      ...(typeof tool.label === 'string' ? { label: tool.label } : {}),
      ...(typeof tool.summary === 'string' ? { summary: tool.summary } : {}),
      ...(typeof tool.durationMs === 'number' ? { durationMs: tool.durationMs } : {}),
    }];
  });
}
