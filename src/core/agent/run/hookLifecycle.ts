import { awaitWithSignal } from '@core/tools/awaitWithSignal';
import type { TraceSpanHandle } from '@core/trace/TraceRecorder';
import type { RunContext } from './RunContext';

export async function startHooks(ctx: RunContext): Promise<void> {
  const factory = ctx.deps.createHookRuntime;
  if (!factory) return;
  const spans = new Map<string, TraceSpanHandle>();
  const runtime = await awaitWithSignal(factory({ projectRoot: ctx.projectRoot, signal: ctx.controller.signal, assertBudget: () => ctx.runBudget.assertAvailable(),
    onStart: (hook) => { spans.set(hook.invocationId, ctx.trace.child('hook', hook.id, { phase: hook.phase, id: hook.id, source: hook.source, command: hook.command })); },
    onResult: (result) => {
      const status = result.status === 'cancelled' ? 'cancelled' : ['failed', 'blocked'].includes(result.status) ? 'failed' : 'success';
      spans.get(result.invocationId)?.end({ status, error: status === 'success' ? undefined : result.reason || result.output || 'Hook 未通过', attributes: { phase: result.phase, id: result.id, source: result.source, command: result.command, status: result.status, exitCode: result.exitCode, output: result.output, sandbox: result.sandbox, policy: result.policy, reason: result.reason } });
      spans.delete(result.invocationId);
    },
  }), ctx.controller.signal);
  ctx.hookRunner = runtime.runner;
  if (runtime.diagnostics.length) ctx.trace.child('context', 'hooks.load', { diagnostics: runtime.diagnostics }).end();
  await runtime.runner.run('run_start', { signal: ctx.controller.signal });
}

/** Lifecycle failures are recorded without changing the task's original outcome. */
export async function endHooks(ctx: RunContext): Promise<void> {
  if (!ctx.hookRunner) return;
  try { await ctx.hookRunner.run('run_end', { signal: ctx.controller.signal }); }
  catch (error) {
    try { ctx.trace.child('hook', 'run_end', { phase: 'run_end' }).end({ status: ctx.controller.signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : String(error) }); } catch { /* Preserve the original outcome even if telemetry is unavailable. */ }
  }
}
