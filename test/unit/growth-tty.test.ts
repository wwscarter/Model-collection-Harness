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
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(manager.listSessions()).toEqual([]);
  });

  it('ignores renderer-supplied shells and strips secrets from the environment', async () => {
    let receivedShell = '';
    let receivedEnv: NodeJS.ProcessEnv = {};
    const factory: TtyProcessFactory = (shell, _args, options) => {
      receivedShell = shell;
      receivedEnv = options.env;
      return { pid: 7, write: () => undefined, resize: () => undefined, kill: () => undefined, onData: () => undefined, onExit: () => undefined };
    };
    manager = new TtyManager({ ptyFactory: factory, defaultShell: '/bin/fake-shell' });
    const original = process.env.AMD_ENCRYPTION_KEY;
    process.env.AMD_ENCRYPTION_KEY = 'must-not-leak';
    try {
      await manager.createSession({ shell: '/bin/evil', env: { AMD_ENCRYPTION_KEY: 'also-secret', PATH: '/custom/bin', LANG: 'zh_CN.UTF-8' } });
    } finally {
      if (original === undefined) delete process.env.AMD_ENCRYPTION_KEY; else process.env.AMD_ENCRYPTION_KEY = original;
    }
    expect(receivedShell).toBe('/bin/fake-shell');
    expect(receivedEnv.AMD_ENCRYPTION_KEY).toBeUndefined();
    expect(receivedEnv.PATH).toBe('/custom/bin');
    expect(receivedEnv.LANG).toBe('zh_CN.UTF-8');
    expect(receivedEnv.TERM).toBe('xterm-256color');
  });

  it('rejects a terminal working directory that does not exist', async () => {
    manager = new TtyManager({ ptyFactory: () => ({ pid: 1, write: () => undefined, resize: () => undefined, kill: () => undefined, onData: () => undefined, onExit: () => undefined }) });
    await expect(manager.createSession({ cwd: '/definitely/not/a/real/directory' })).rejects.toThrow('工作目录');
  });

  it('releases a terminal session and its listeners after a natural exit', async () => {
    let onExit: (() => void) | undefined;
    let onData: ((data: string) => void) | undefined;
    manager = new TtyManager({ ptyFactory: () => ({
      write: () => undefined, resize: () => undefined, kill: () => undefined,
      onData: (listener) => { onData = listener; }, onExit: (listener) => { onExit = () => listener(); },
    }) });
    const session = await manager.createSession({ id: 'natural-exit' });
    const output: string[] = [];
    manager.onData(session.id, (data) => output.push(data));
    onData?.('before exit');
    onExit?.();
    onData?.('after exit');
    expect(output).toEqual(['before exit']);
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(manager.listSessions()).toEqual([]);
  });
});
