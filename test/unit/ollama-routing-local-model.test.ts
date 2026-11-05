import { describe, expect, it, vi } from 'vitest';
import { LocalRoutingModel, type RoutingClassifier, type LocalRoutingModelOptions } from '@core/routing/LocalRoutingModel';

describe('LocalRoutingModel classifier adapter', () => {
  it('forwards context and cancellation without changing the backend classification confidence', async () => {
    const signal = new AbortController().signal;
    const classify = vi.fn<RoutingClassifier['classify']>().mockResolvedValue({ taskType: 'analysis', complexity: 'high', confidence: 0, rationale: 'adapter classification', backend: 'ollama', model: 'local:1b', promptVersion: 'v3' });
    const backend: RoutingClassifier = { classify, getStatus: () => ({ backend: 'ollama', available: false, configured: true, model: 'local:1b' }) };
    const model = new LocalRoutingModel({ classifier: backend });
    const context = { type: 'general' as const, description: '继续比较', priorContext: '此前有两个实现方案' };
    expect(await model.classify(context, { signal })).toMatchObject({ confidence: 0, backend: 'ollama', model: 'local:1b' });
    expect(classify).toHaveBeenCalledWith(context, { signal });
    expect(model.getStatus()).toEqual(backend.getStatus());
  });

  it('returns the original heuristic classification with diagnostics when an adapter is unavailable', async () => {
    const context = { type: 'general' as const, description: '全面审查代码架构' };
    const expected = await new LocalRoutingModel().classify(context);
    const backend: RoutingClassifier = { classify: async () => { throw new Error('classifier busy'); }, getStatus: () => ({ backend: 'ollama', available: false, model: 'local:1b', promptVersion: 'v3' }) };
    expect(await new LocalRoutingModel({ classifier: backend }).classify(context)).toMatchObject({ ...expected, fallbackReason: 'classifier busy', model: 'local:1b', promptVersion: 'v3' });
  });

  it('does not swallow cancellation when a legacy completion adapter fails to settle', async () => {
    const controller = new AbortController();
    const complete = vi.fn<NonNullable<LocalRoutingModelOptions['complete']>>(async () => new Promise<string>(() => {}));
    const model = new LocalRoutingModel({ complete });
    const pending = model.classify({ type: 'general', description: 'write code' }, { signal: controller.signal });
    controller.abort(new Error('cancel legacy request'));
    await expect(pending).rejects.toThrow('cancel legacy request');
    expect(complete.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });

  it('does not start an adapter for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled before routing'));
    const complete = vi.fn(async () => '{}');
    await expect(new LocalRoutingModel({ complete }).classify({ type: 'general', description: 'hello' }, { signal: controller.signal })).rejects.toThrow('cancelled before routing');
    expect(complete).not.toHaveBeenCalled();
  });
});
