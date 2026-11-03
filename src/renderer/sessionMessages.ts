export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  modelUsed?: string;
  planningModelId?: string;
  agents?: ChatAgentMessage[];
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
