import type { ChatTurn } from './AgentRuntimeTypes';

const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 60_000;

/** Keep the newest turns that fit the budget; always start the window on a user turn. */
export function trimHistory(history: ChatTurn[] = [], maxTurns = MAX_HISTORY_TURNS, maxChars = MAX_HISTORY_CHARS): ChatTurn[] {
  const clean = history.filter((turn) => (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string' && turn.content.trim());
  const kept: ChatTurn[] = [];
  let chars = 0;
  for (let index = clean.length - 1; index >= 0 && kept.length < maxTurns; index -= 1) {
    chars += clean[index].content.length;
    if (chars > maxChars) break;
    kept.unshift(clean[index]);
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

export function textOf(message: { content?: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part: { type?: string; text?: string }) => part?.type === 'text' ? part.text ?? '' : '').join('');
}

export function summarizeToolResult(result: unknown): string | undefined {
  const text = textOf((result ?? {}) as { content?: unknown }).trim();
  return text ? text.slice(0, 280) : undefined;
}

