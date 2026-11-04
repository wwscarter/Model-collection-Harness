import { createHash } from 'node:crypto';

export interface ContextToolDigest {
  name: string;
  status?: string;
  label?: string;
  summary?: string;
}

export interface ContextTurn {
  role: 'user' | 'assistant';
  content: string;
  tools?: ContextToolDigest[];
}

export interface ContextAssemblyInput {
  history: ContextTurn[];
  summary?: string;
  /** Number of leading history turns represented by summary. */
  summaryCovers?: number;
  /** Hash of the leading turns represented by summary. */
  summaryHash?: string;
  contextWindow: number;
  maxOutputTokens: number;
  reserveTokens?: number;
  maxInputTokens?: number;
  /** Always keep this many of the newest turns verbatim when possible. */
  minRecentTurns?: number;
}

export interface ContextAssemblyResult {
  history: ContextTurn[];
  summary?: string;
  summaryCovers: number;
  summaryHash?: string;
  estimatedTokens: number;
  droppedTurns: number;
  /** The previously-summarised prefix the assembler started from. */
  previousCovers: number;
  compacted: boolean;
  summaryChanged: boolean;
}

const DEFAULT_RESERVE_TOKENS = 8_000;
const DEFAULT_MIN_RECENT_TURNS = 2;
const SUMMARY_LINE_CHARS = 160;

export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function renderTurn(turn: ContextTurn): ContextTurn {
  const tools = turn.tools?.filter((tool) => tool.name);
  if (!tools?.length) return turn;
  const lines = tools.map((tool) => {
    const label = tool.label ? ` (${tool.label.slice(0, 160)})` : '';
    const summary = tool.summary ? `: ${tool.summary.slice(0, 240)}` : '';
    return `- ${tool.name}${label}: ${tool.status ?? 'completed'}${summary}`;
  });
  return { ...turn, content: `${turn.content}\n\n[tool results]\n${lines.join('\n')}` };
}

export function historyHash(history: readonly ContextTurn[], count: number): string {
  const body = history.slice(0, Math.max(0, Math.min(count, history.length))).map((turn) => ({
    role: turn.role,
    content: turn.content,
    tools: turn.tools?.map((tool) => ({ name: tool.name, status: tool.status, label: tool.label, summary: tool.summary })),
  }));
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function estimateTurn(turn: ContextTurn): number {
  return estimateTextTokens(turn.content) + 6;
}

function composeSummary(previous: string | undefined, turns: readonly ContextTurn[]): string {
  const lines = turns.map((turn) => {
    const digest = turn.tools?.length
      ? ` [tools: ${turn.tools.map((tool) => `${tool.name}/${tool.status ?? 'done'}`).join(', ')}]`
      : '';
    return `- ${turn.role}: ${turn.content.replace(/\s+/g, ' ').slice(0, SUMMARY_LINE_CHARS)}${digest}`;
  });
  return [previous?.trim() ? `Earlier conversation summary:\n${previous.trim()}` : 'Earlier conversation summary:', ...lines].join('\n');
}

function boundSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.max(0, maxChars - 40));
  return `${head}\n[summary truncated]`;
}

/**
 * Assemble a model input within a token budget.
 *
 * Phase 1 is deliberately deterministic: older turns become a plain-text
 * summary instead of an extra LLM call. The summary is persisted by the caller
 * with its covered-turn count and prefix hash so later turns can extend it
 * without re-summarizing history that has not changed.
 */
export function assembleContext(input: ContextAssemblyInput): ContextAssemblyResult {
  const minimumRecent = Math.max(0, input.minRecentTurns ?? DEFAULT_MIN_RECENT_TURNS);
  const reserve = Math.max(0, input.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
  const configBudget = Math.max(512, (input.contextWindow || 8_192) - Math.max(1, input.maxOutputTokens) - reserve);
  const budget = Math.max(512, Math.min(configBudget, input.maxInputTokens ?? Number.MAX_SAFE_INTEGER));
  const rendered = input.history.map(renderTurn);
  const existingSummary = input.summary?.trim() || undefined;
  const covers = input.summaryCovers ?? 0;
  const summaryValid = Boolean(existingSummary) && covers > 0 && covers <= input.history.length
    && input.summaryHash === historyHash(input.history, covers);
  const baseSummary = summaryValid ? existingSummary : undefined;
  const baseCovers = summaryValid ? covers : 0;

  const baseHistory = rendered.slice(baseCovers);
  const totalTokens = baseHistory.reduce((sum, turn) => sum + estimateTurn(turn), 0) + (baseSummary ? estimateTextTokens(baseSummary) : 0);
  if (totalTokens <= budget || baseHistory.length <= minimumRecent) {
    return {
      history: baseHistory,
      summary: baseSummary,
      summaryCovers: baseCovers,
      summaryHash: baseSummary ? historyHash(input.history, baseCovers) : undefined,
      estimatedTokens: totalTokens,
      droppedTurns: baseCovers,
      previousCovers: baseCovers,
      compacted: false,
      summaryChanged: false,
    };
  }

  // Keep as much of the newest conversation as fits in roughly 70% of the budget.
  const recentBudget = Math.floor(budget * 0.7);
  let keepStart = input.history.length;
  let recentTokens = 0;
  for (let index = input.history.length - 1; index >= baseCovers; index -= 1) {
    const tokens = estimateTurn(rendered[index]);
    const keptCount = input.history.length - index;
    if (recentTokens + tokens > recentBudget && keptCount > minimumRecent) break;
    recentTokens += tokens;
    keepStart = index;
  }
  keepStart = Math.min(keepStart, Math.max(baseCovers, input.history.length - minimumRecent));

  const older = input.history.slice(baseCovers, keepStart);
  const summaryBudgetChars = Math.max(400, Math.floor(budget * 0.25) * 4);
  let nextSummary = older.length ? boundSummary(composeSummary(baseSummary, older.map(renderTurn)), summaryBudgetChars) : baseSummary;
  let finalCovers = keepStart;
  const recent = rendered.slice(keepStart);

  // If the summary plus recent turns still exceed the budget, fold the oldest
  // recent turns into the summary as they are dropped. The returned history and
  // summaryCovers must stay aligned or the next turn would reuse a wrong hash.
  let estimated = recent.reduce((sum, turn) => sum + estimateTurn(turn), 0) + (nextSummary ? estimateTextTokens(nextSummary) : 0);
  const droppedRecent: ContextTurn[] = [];
  while (estimated > budget && recent.length > minimumRecent) {
    const removed = recent.shift();
    if (!removed) continue;
    droppedRecent.push(removed);
    estimated -= estimateTurn(removed);
  }
  if (droppedRecent.length) {
    nextSummary = boundSummary(composeSummary(baseSummary, [...older.map(renderTurn), ...droppedRecent]), summaryBudgetChars);
    finalCovers = keepStart + droppedRecent.length;
    estimated = recent.reduce((sum, turn) => sum + estimateTurn(turn), 0) + (nextSummary ? estimateTextTokens(nextSummary) : 0);
  }
  if (estimated > budget && recent.length) {
    const overflow = (estimated - budget) * 4;
    const first = recent[0];
    if (first && first.content.length > overflow + 80) {
      const trimmed = `${first.content.slice(0, Math.max(80, first.content.length - overflow))}\n[truncated to fit context budget]`;
      recent[0] = { ...first, content: trimmed };
      estimated = recent.reduce((sum, turn) => sum + estimateTurn(turn), 0) + (nextSummary ? estimateTextTokens(nextSummary) : 0);
    }
  }

  return {
    history: recent,
    summary: nextSummary,
    summaryCovers: finalCovers,
    summaryHash: historyHash(input.history, finalCovers),
    estimatedTokens: estimated,
    droppedTurns: finalCovers,
    previousCovers: baseCovers,
    compacted: true,
    summaryChanged: nextSummary !== existingSummary || finalCovers !== (input.summaryCovers ?? 0),
  };
}
