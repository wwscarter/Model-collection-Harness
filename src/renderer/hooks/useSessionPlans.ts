import { useEffect, useState } from 'react';
import type { PlanDecision, RunPlan } from '@core/planning/PlanTypes';
import { errorMessage } from '../format';

function mergePlans(current: RunPlan[], incoming: RunPlan[]): RunPlan[] {
  const merged = new Map(current.map((plan) => [plan.runId, plan]));
  for (const plan of incoming) {
    const existing = merged.get(plan.runId);
    if (!existing || existing.version < plan.version || (existing.version === plan.version && existing.updatedAt <= plan.updatedAt)) merged.set(plan.runId, plan);
  }
  return [...merged.values()];
}

export function useSessionPlans(sessionId?: string) {
  const [plans, setPlans] = useState<RunPlan[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => window.amd?.on('session:plan', (payload) => {
    const plan = payload as RunPlan;
    if (!plan.runId || !plan.sessionId || !plan.plan || !Array.isArray(plan.plan.steps)) return;
    setPlans((current) => mergePlans(current, [plan]));
  }), []);
  useEffect(() => {
    let active = true; setError(undefined);
    if (sessionId) void window.amd?.sessions.plans?.(sessionId).then((stored) => { if (active) setPlans((current) => mergePlans(current, stored)); }).catch((cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [sessionId]);
  const decide = async (decision: PlanDecision) => {
    if (!window.amd?.sessions.planDecision) throw new Error('计划确认服务尚未连接');
    const result = await window.amd.sessions.planDecision(decision);
    setPlans((current) => mergePlans(current, [result]));
  };
  return { sessionPlans: plans.filter((plan) => plan.sessionId === sessionId), planError: error, decidePlan: decide };
}
