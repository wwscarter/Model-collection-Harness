import type { OrchestrationPlan } from '@core/routing/Orchestrator';

export type PlanningMode = 'auto' | 'confirm' | 'only';
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'skipped';
export interface PlanStep { id: string; title: string; detail?: string; status: PlanStepStatus; }
export type PlanStatus = 'ready' | 'awaiting' | 'approved' | 'executing' | 'completed' | 'cancelled' | 'failed';
export interface RunPlan {
  sessionId: string;
  runId: string;
  assistantMessageId: string;
  version: number;
  executionMode: PlanningMode;
  status: PlanStatus;
  plan: OrchestrationPlan;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
}
export interface PlanDecision { runId: string; version: number; action: 'approve' | 'edit' | 'cancel'; steps?: PlanStep[]; }

export function planningMode(value: unknown): PlanningMode {
  if (!['auto', 'confirm', 'only'].includes(value as string)) throw new Error('规划模式无效');
  return value as PlanningMode;
}

export function parsePlanSteps(value: unknown, fallback?: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value)) for (const item of value.slice(0, 24)) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Partial<PlanStep>;
    const title = typeof entry.title === 'string' ? entry.title.trim().slice(0, 200) : '';
    if (!title) continue;
    const proposed = typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{1,60}$/.test(entry.id) ? entry.id : 'step-' + (steps.length + 1);
    let id = proposed;
    let suffix = 1;
    while (seen.has(id)) id = 'step-' + (steps.length + 1) + '-' + suffix++;
    seen.add(id);
    steps.push({ id, title, ...(typeof entry.detail === 'string' && entry.detail.trim() ? { detail: entry.detail.trim().slice(0, 2000) } : {}), status: 'pending' });
  }
  if (!steps.length && fallback?.trim()) steps.push({ id: 'step-1', title: '执行计划', detail: fallback.trim().slice(0, 4000), status: 'pending' });
  return steps;
}
