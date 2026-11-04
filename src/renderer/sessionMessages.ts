export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  modelUsed?: string;
  planningModelId?: string;
  agents?: ChatAgentMessage[];
  tools?: ChatToolCall[];
}

/** A tool call the model made while answering (web search, page fetch, file read). */
export interface ChatToolCall {
  id: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  label?: string;
  summary?: string;
  durationMs?: number;
}

export interface ToolCallUpdate {
  toolCallId: string;
  toolName: string;
  status: ChatToolCall['status'];
  args?: unknown;
  summary?: string;
  durationMs?: number;
}

export interface ChatAgentMessage {
  id: string;
  modelId: string;
  modelName: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  content: string;
  error?: string;
}

type SessionMessageSource = {
  messages?: unknown;
  userMessage?: unknown;
  prompt?: unknown;
  output?: unknown;
  title?: unknown;
};

export function restoreMessages(record: SessionMessageSource): ChatMessage[] {
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
        ...(typeof message.planningModelId === 'string' ? { planningModelId: message.planningModelId } : {}),
        ...(Array.isArray(message.agents) ? { agents: restoreAgents(message.agents) } : {}),
        ...(Array.isArray(message.tools) ? { tools: restoreTools(message.tools) } : {}),
      }];
    });
    if (messages.length) return messages;
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

export function updateAssistantAgent(
  messages: ChatMessage[],
  messageId: string,
  update: { agentId: string; status?: ChatAgentMessage['status']; delta?: string; content?: string; error?: string },
): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== messageId || message.role !== 'assistant' || !message.agents) return message;
    return {
      ...message,
      agents: message.agents.map((agent) => agent.id !== update.agentId ? agent : {
        ...agent,
        ...(update.status ? { status: update.status } : {}),
        ...(update.content !== undefined ? { content: update.content } : update.delta ? { content: `${agent.content}${update.delta}` } : {}),
        ...(update.error ? { error: update.error } : {}),
      }),
    };
  });
}

export function updateLatestAssistantAttribution(messages: ChatMessage[], update: { modelUsed?: string; planningModelId?: string }): ChatMessage[] {
  let messageIndex = messages.length - 1;
  while (messageIndex >= 0 && messages[messageIndex].role !== 'assistant') messageIndex -= 1;
  if (messageIndex < 0) return messages;
  return messages.map((message, index) => index === messageIndex ? { ...message, ...update } : message);
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

function restoreAgents(values: unknown[]): ChatAgentMessage[] {
  return values.flatMap((value): ChatAgentMessage[] => {
    if (!value || typeof value !== 'object') return [];
    const agent = value as Partial<ChatAgentMessage>;
    if (typeof agent.id !== 'string' || typeof agent.modelId !== 'string' || typeof agent.modelName !== 'string' || typeof agent.content !== 'string') return [];
    if (agent.status !== 'queued' && agent.status !== 'running' && agent.status !== 'completed' && agent.status !== 'failed') return [];
    return [{ id: agent.id, modelId: agent.modelId, modelName: agent.modelName, status: agent.status, content: agent.content, ...(typeof agent.error === 'string' ? { error: agent.error } : {}) }];
  });
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
  return messages.filter((message) => message.content.trim()).map((message) => ({
    role: message.role,
    content: message.content,
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
