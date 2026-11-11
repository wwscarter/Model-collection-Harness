import type { MediaJob } from '@core/media/MediaTypes';
import type { TraceSpanHandle } from '@core/trace/TraceRecorder';
import type { RunDependencies } from './RunTypes';

/** Record protocol calls separately from the text worker which requested them. */
export function createMediaObserver(deps: RunDependencies, trace: TraceSpanHandle, runId: string) {
  const attempts = new Map<string, { span: TraceSpanHandle; invocationId: string; ended: boolean }>();
  return (job: MediaJob) => {
    job.attempts.forEach((attempt, index) => {
      const key = job.id + ':' + index;
      let observed = attempts.get(key);
      if (!observed) {
        observed = { span: trace.child('model', 'media.generate', { modelId: attempt.configurationId, modelSnapshot: attempt.modelSnapshot, operation: job.operation, jobId: job.id, agentId: job.agentId, reason: attempt.reason, protocol: attempt.protocol }), invocationId: deps.observability.recordInvocationStart(runId, attempt.configurationId), ended: false };
        attempts.set(key, observed);
      }
      if (observed.ended || attempt.status === 'submitting') return;
      observed.ended = true;
      const last = index === job.attempts.length - 1;
      const usage = last && job.usage && typeof job.usage === 'object' ? job.usage as { input_tokens?: unknown; output_tokens?: unknown } : {};
      const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
      const input = count(usage.input_tokens), output = count(usage.output_tokens);
      const cost = last && attempt.status !== 'failed' ? job.actualCostUsd ?? job.estimatedCostUsd ?? 0 : 0;
      deps.observability.recordInvocationEnd(observed.invocationId, input, output, { input: 0, output: 0 }, attempt.status === 'succeeded' ? 'success' : 'failure', attempt.error, cost);
      observed.span.end({ status: attempt.status === 'succeeded' ? 'success' : 'failed', error: attempt.error, inputTokens: input, outputTokens: output, cost, attributes: { jobStatus: job.status, costStatus: job.costStatus, assetIds: job.artifacts.map((asset) => asset.id) } });
    });
  };
}
