import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanStorage } from '../../src/core/planning/PlanStorage';
import { PlanController } from '../../src/core/planning/PlanController';
import type { RunPlan } from '../../src/core/planning/PlanTypes';
import { parseOrchestratorPlan } from '../../src/core/routing/Orchestrator';
import { RunBudget } from '../../src/core/routing/RunBudget';

const draft = () => ({ sessionId: 'session', runId: 'run', assistantMessageId: 'message', executionMode: 'confirm' as const, status: 'awaiting' as const, plan: { mode: 'direct' as const, taskType: 'code' as const, complexity: 'low' as const, steps: [{ id: 'inspect', title: 'Inspect the project', status: 'pending' as const }], subagents: [], verify: false } });
afterEach(() => vi.useRealTimers());

describe('durable execution plans', () => {
  it('parses structured steps, falls back to text and ignores malformed JSON', () => {
    expect(parseOrchestratorPlan(JSON.stringify({ mode: 'direct', steps: [{ id: 'inspect', title: 'Inspect files', status: 'done' }] }), [], '')?.steps).toEqual([{ id: 'inspect', title: 'Inspect files', status: 'pending' }]);
    expect(parseOrchestratorPlan(JSON.stringify({ mode: 'direct', plan: 'Inspect, implement, verify.' }), [], '')?.steps[0].detail).toBe('Inspect, implement, verify.');
    expect(parseOrchestratorPlan('An incomplete response', [], '')).toBeUndefined();
  });
  it('assigns unique ids to ordinary repeated model-generated step ids', () => {
    const parsed = parseOrchestratorPlan(JSON.stringify({ mode: 'direct', steps: [{ id: 'a', title: 'First' }, { id: 'step-3-1', title: 'Second' }, { id: 'a', title: 'Third' }] }), [], '')!;
    expect(new Set(parsed.steps.map((step) => step.id)).size).toBe(3);
    expect(parsed.steps.map((step) => step.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('persists edits as versions and restores approval and actual step progress', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-plans-'));
    const file = path.join(root, 'sessions.db');
    const storage = new PlanStorage(file);
    try {
      const plans = new PlanController(storage); const initial = plans.create(draft());
      const events: RunPlan[] = [];
      const waiting = plans.wait(initial, new AbortController().signal, (event) => events.push(event));
      const edited = plans.decide({ runId: 'run', version: 1, action: 'edit', steps: [{ id: 'inspect', title: 'Inspect relevant files only', status: 'pending' }] });
      expect(edited.version).toBe(2); expect(plans.latest('run')?.status).toBe('awaiting');
      const approved = plans.decide({ runId: 'run', version: 2, action: 'approve' });
      expect(await waiting).toMatchObject({ version: 2, status: 'approved' });
      expect(approved.approvedAt).toBeTruthy();
      plans.status('run', 'executing', (event) => events.push(event));
      plans.updateStep('run', 'inspect', 'done', (event) => events.push(event));
      expect(storage.versions('run').map((plan) => plan.version)).toEqual([1, 2]);
      expect(storage.list('session')[0].plan.steps[0].status).toBe('done');
      storage.close();
      const reopened = new PlanStorage(file);
      try { expect(reopened.list('session')[0]).toMatchObject({ version: 2, approvedAt: approved.approvedAt }); reopened.deleteSession('session'); expect(reopened.list('session')).toEqual([]); }
      finally { reopened.close(); }
    } finally { storage.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('cancels confirmation through the run signal and records its final state', async () => {
    const plans = new PlanController(); const controller = new AbortController();
    const pending = plans.wait(plans.create(draft()), controller.signal, () => undefined);
    const rejected = expect(pending).rejects.toThrow('任务已取消'); controller.abort(); await rejected;
    expect(plans.latest('run')?.status).toBe('cancelled');
  });

  it('ends an ordinary unanswered confirmation after thirty minutes', async () => {
    vi.useFakeTimers();
    const plans = new PlanController(); const pending = plans.wait(plans.create(draft()), new AbortController().signal, () => undefined);
    const rejected = expect(pending).rejects.toThrow('任务已取消');
    await vi.advanceTimersByTimeAsync(30 * 60_000); await rejected;
    expect(plans.latest('run')?.status).toBe('cancelled');
  });

  it('excludes confirmation pauses from elapsed budget while retaining usage limits', () => {
    let now = 0; const budget = new RunBudget({ maxCost: 1, maxDurationMs: 1000, now: () => now });
    now = 400; budget.pause(); now += 30 * 60_000;
    expect(budget.snapshot().elapsedMs).toBe(400); budget.assertAvailable(); budget.resume();
    now += 500; expect(budget.snapshot().elapsedMs).toBe(900); budget.assertAvailable();
    now += 101; expect(() => budget.assertAvailable()).toThrow('秒预算');
  });
});
