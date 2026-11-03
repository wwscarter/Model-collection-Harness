import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GrowthEngine } from '../../src/core/growth/GrowthEngine';
import { TtyManager, type TtyProcessFactory } from '../../src/core/tty/TtyManager';

describe('GrowthEngine', () => {
  it('updates profiles with an exponential moving average and persists them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-growth-'));
    const file = path.join(dir, 'profiles.json');
    const first = new GrowthEngine({ storagePath: file, learningRate: 0.1 });
    first.recordFeedback({ modelId: 'model-a', taskType: 'code', success: true, actualCost: 0.1, actualLatency: 100, auditApproval: true, userSatisfaction: 5 });
    first.recordFeedback({ modelId: 'model-a', taskType: 'code', success: false, actualCost: 0.3, actualLatency: 300, auditApproval: false, userSatisfaction: 1 });
    const profile = first.getProfile('model-a', 'code');
    expect(profile?.sampleCount).toBe(2);
    expect(profile?.successRate).toBeCloseTo(0.9, 5);
    expect(profile?.avgCost).toBeCloseTo(0.12, 5);
    expect(first.getRoutingAdjustment('model-a', 'code')).toBeGreaterThan(0);
    const reopened = new GrowthEngine({ storagePath: file });
    expect(reopened.getProfile('model-a', 'code')?.sampleCount).toBe(2);
    reopened.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('TtyManager', () => {
  let manager: TtyManager | undefined;
  afterEach(() => manager?.dispose());

  it('manages an injected process without requiring node-pty', async () => {
    const outputListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<() => void>();
    const writes: string[] = [];
    const factory: TtyProcessFactory = (_shell, _args, options) => ({
      pid: 42,
      write: (data) => { writes.push(data); outputListeners.forEach((listener) => listener(`echo:${data}`)); },
      resize: () => undefined,
      kill: () => exitListeners.forEach((listener) => listener()),
      onData: (listener) => { outputListeners.add(listener); },
      onExit: (listener) => { exitListeners.add(() => listener()); },
    });
    manager = new TtyManager({ ptyFactory: factory });
    const session = await manager.createSession({ id: 'test-tty', cols: 100, rows: 20 });
    const output: string[] = [];
    const unsubscribe = manager.onData(session.id, (data) => output.push(data));
    manager.write(session.id, 'hello');
    manager.resize(session.id, 90, 18);
    expect(writes).toEqual(['hello']);
    expect(output).toEqual(['echo:hello']);
    expect(manager.getSession(session.id)?.cols).toBe(90);
    unsubscribe();
    expect(manager.close(session.id)).toBe(true);
    expect(manager.getSession(session.id)?.status).toBe('closed');
  });
});
