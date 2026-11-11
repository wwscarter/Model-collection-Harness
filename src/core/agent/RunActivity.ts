/** Serializable activity shown in a conversation; never contains runtime credentials or raw tool payloads. */
export interface ActivityTool {
  id: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  label?: string;
  summary?: string;
  durationMs?: number;
}

export interface AgentActivity {
  id: string;
  /** Stable configuration identifier, retained for legacy histories. */
  modelId: string;
  modelName: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  content: string;
  error?: string;
  /** Upstream model identifier captured for this invocation. */
  actualModelId?: string;
  role?: string;
  task?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  stopReason?: string;
  tools?: ActivityTool[];
}

export interface ExecutionAttempt {
  id: string;
  index: number;
  modelId: string;
  actualModelId: string;
  modelName: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  reason?: string;
  error?: string;
}

const agentStatuses = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const attemptStatuses = new Set(['running', 'completed', 'failed', 'cancelled']);
const toolStatuses = new Set(['running', 'completed', 'failed']);
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 300;
const text = (value: unknown, limit: number): string | undefined => typeof value === 'string' ? value.slice(0, limit) : undefined;
const duration = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const timestamp = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value)) ? value : undefined;
function optionalText(source: Record<string, unknown>, fields: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).flatMap(([key, limit]) => { const value = text(source[key], limit); return value === undefined ? [] : [[key, value]]; }));
}

export function normalizeActivityTools(value: unknown): ActivityTool[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 50).flatMap((item): ActivityTool[] => {
    const tool = record(item);
    if (!tool || !identifier(tool.id) || seen.has(tool.id) || !identifier(tool.toolName) || !toolStatuses.has(String(tool.status))) return [];
    seen.add(tool.id);
    const durationMs = duration(tool.durationMs);
    return [{ id: tool.id, toolName: tool.toolName, status: tool.status as ActivityTool['status'],
      ...optionalText(tool, { label: 300, summary: 2000 }), ...(durationMs === undefined ? {} : { durationMs }) }];
  });
}

export function normalizeAgents(value: unknown): AgentActivity[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 8).flatMap((item): AgentActivity[] => {
    const agent = record(item);
    if (!agent || !identifier(agent.id) || seen.has(agent.id) || !identifier(agent.modelId) || !identifier(agent.modelName) || typeof agent.content !== 'string' || !agentStatuses.has(String(agent.status))) return [];
    seen.add(agent.id);
    const startedAt = timestamp(agent.startedAt), finishedAt = timestamp(agent.finishedAt), durationMs = duration(agent.durationMs);
    return [{ id: agent.id, modelId: agent.modelId, modelName: agent.modelName, status: agent.status as AgentActivity['status'], content: agent.content.slice(0, 40000),
      ...optionalText(agent, { error: 2000, actualModelId: 300, role: 100, task: 4000, stopReason: 100 }),
      ...(startedAt ? { startedAt } : {}), ...(finishedAt ? { finishedAt } : {}), ...(durationMs === undefined ? {} : { durationMs }),
      ...(Array.isArray(agent.tools) ? { tools: normalizeActivityTools(agent.tools) } : {}) }];
  });
}

export function normalizeExecutionAttempts(value: unknown): ExecutionAttempt[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 50).flatMap((item): ExecutionAttempt[] => {
    const attempt = record(item);
    const startedAt = timestamp(attempt?.startedAt);
    if (!attempt || !identifier(attempt.id) || seen.has(attempt.id) || !identifier(attempt.modelId) || !identifier(attempt.actualModelId) || !identifier(attempt.modelName) || !Number.isInteger(attempt.index) || (attempt.index as number) < 0 || !startedAt || !attemptStatuses.has(String(attempt.status))) return [];
    seen.add(attempt.id);
    const finishedAt = timestamp(attempt.finishedAt), durationMs = duration(attempt.durationMs);
    return [{ id: attempt.id, index: attempt.index as number, modelId: attempt.modelId, actualModelId: attempt.actualModelId, modelName: attempt.modelName, status: attempt.status as ExecutionAttempt['status'], startedAt,
      ...optionalText(attempt, { reason: 2000, error: 2000 }), ...(finishedAt ? { finishedAt } : {}), ...(durationMs === undefined ? {} : { durationMs }) }];
  });
}
