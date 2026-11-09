import { beforeAll, describe, expect, it, vi } from 'vitest';

type Listener = (payload: unknown) => void;
type IpcListener = (event: unknown, payload: unknown) => void;
const state = vi.hoisted(() => ({
  handlers: new Map<string, Set<IpcListener>>(),
  api: undefined as unknown as { on(channel: string, listener: Listener): () => void; off(channel: string, listener: Listener): void },
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: typeof state.api) => { state.api = api; } },
  ipcRenderer: {
    invoke: vi.fn(),
    on: (channel: string, handler: IpcListener) => {
      const handlers = state.handlers.get(channel) ?? new Set<IpcListener>();
      handlers.add(handler);
      state.handlers.set(channel, handlers);
    },
    removeListener: (channel: string, handler: IpcListener) => state.handlers.get(channel)?.delete(handler),
  },
}));
beforeAll(async () => { await import('../../src/main/preload'); });
const emit = (channel: string, payload: unknown) => { for (const handler of state.handlers.get(channel) ?? []) handler({}, payload); };

describe('preload subscriptions', () => {
  it('forwards project verification progress and supports its cleanup', () => {
    const listener = vi.fn();
    const stop = state.api.on('session:verification', listener);
    const event = { sessionId: 'fixture', phase: 'checking' };
    emit('session:verification', event);
    expect(listener).toHaveBeenCalledExactlyOnceWith(event);
    stop();
    emit('session:verification', event);
    expect(listener).toHaveBeenCalledOnce();
  });
  it('removes wrapped listeners through the public off API without affecting other channels', () => {
    const listener = vi.fn();
    state.api.on('session:chunk', listener);
    const stopTrace = state.api.on('session:trace', listener);
    emit('session:chunk', 'first');
    state.api.off('session:chunk', listener);
    emit('session:chunk', 'removed');
    emit('session:trace', 'trace');
    expect(listener.mock.calls).toEqual([['first'], ['trace']]);
    stopTrace();
  });

  it('supports independent unsubscribe functions and duplicate listener registrations', () => {
    const listener = vi.fn();
    const stopFirst = state.api.on('session:chunk', listener);
    const stopSecond = state.api.on('session:chunk', listener);
    stopFirst();
    stopFirst();
    emit('session:chunk', 'once');
    expect(listener).toHaveBeenCalledExactlyOnceWith('once');
    state.api.off('session:chunk', listener);
    stopSecond();
    emit('session:chunk', 'removed');
    expect(listener).toHaveBeenCalledOnce();
  });
});
