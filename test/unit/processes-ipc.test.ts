import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainContext } from '../../src/main/MainContext';
import type { ProjectProcessSnapshot } from '../../src/core/tty/ProjectProcessManager';

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: never[]) => unknown>() }));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: never[]) => unknown) => state.handlers.set(channel, handler) },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
}));

const event = { senderFrame: { url: 'file:///newai/dist/renderer/index.html' } };
const invoke = (channel: string, ...args: unknown[]) => state.handlers.get(channel)!(event as never, ...(args as never[]));

function snapshot(overrides: Partial<ProjectProcessSnapshot> = {}): ProjectProcessSnapshot {
  return {
    id: 'process-1', processId: 'process-1', pid: 99, sessionId: 'session-1', command: 'npm run dev', cwd: '/project',
    background: true, status: 'running', running: true, stdout: '', stderr: '', output: 'y'.repeat(6_000),
    urls: ['http://127.0.0.1:5173/'], exitCode: null, timedOut: false, cancelled: false, truncated: true,
    durationMs: 2_000, sandbox: { enabled: true, network: 'allow' }, ...overrides,
  };
}

const list = vi.fn(() => [snapshot(), snapshot({ processId: 'process-2', id: 'process-2', sessionId: 'session-2', command: 'node server.cjs' })]);
const stop = vi.fn(async () => snapshot({ running: false, status: 'stopped' as const }));

beforeEach(async () => {
  state.handlers.clear();
  list.mockClear();
  stop.mockClear();
  const { register } = await import('../../src/main/ipc/processesIpc');
  register({ projectProcesses: { list, stop } } as unknown as MainContext);
});

describe('process IPC', () => {
  it('returns bounded summaries and filters by session', () => {
    const all = invoke('processes:list', '/project') as Array<Record<string, unknown>>;
    expect(list).toHaveBeenCalledWith('/project');
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ processId: 'process-1', sessionId: 'session-1', running: true, sandboxEnabled: true, urls: ['http://127.0.0.1:5173/'] });
    expect((all[0].outputPreview as string).length).toBe(4_000);
    expect(all[0]).not.toHaveProperty('stdout');
    expect(all[0]).not.toHaveProperty('stderr');
    expect(invoke('processes:list', undefined, 'session-2')).toMatchObject([{ processId: 'process-2' }]);
  });

  it('rejects malformed ids and paths before touching the manager', async () => {
    expect(() => invoke('processes:list', 'relative/path')).toThrow('项目路径无效');
    expect(() => invoke('processes:list', '/project', 42)).toThrow('会话 ID 无效');
    await expect(invoke('processes:stop', '', '/project')).rejects.toThrow('进程 ID 无效');
    expect(stop).not.toHaveBeenCalled();
  });

  it('stops a managed process and returns its final summary', async () => {
    const result = await invoke('processes:stop', 'process-1', '/project') as Record<string, unknown>;
    expect(stop).toHaveBeenCalledWith('process-1', '/project');
    expect(result).toMatchObject({ processId: 'process-1', running: false, status: 'stopped' });
  });
});
