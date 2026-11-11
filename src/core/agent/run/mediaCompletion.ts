import type { MediaJob } from '@core/media/MediaTypes';
import type { ToolEvent } from '../AgentRuntimeTypes';

export interface MediaDependencyFailure {
  code: string;
  message: string;
  required: boolean;
  toolName?: 'request_media' | 'materialize_asset';
  artifactSlot?: string;
  revision?: number;
  jobId?: string;
  path?: string;
  callId?: string;
  observedAt?: number;
}
interface Scope { runId: string; sessionId: string; }
export interface MediaCompletion { jobs: MediaJob[]; failures: MediaDependencyFailure[]; blocked: boolean; notice?: string; }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const revision = (value: unknown): number => Number.isInteger(value) && (value as number) >= 0 ? value as number : 0;

/** Keep only currently unresolved tool dependencies; later successful retries release them. */
export function recordMediaToolOutcome(failures: MediaDependencyFailure[], event: ToolEvent, args: unknown, callId = event.toolCallId): void {
  if (!['request_media', 'materialize_asset'].includes(event.toolName) || event.status === 'running') return;
  const toolName = event.toolName as 'request_media' | 'materialize_asset';
  const parameters = record(args), detail = record(event.details), nested = record(detail.details);
  const slot = string(parameters.artifactSlot) ?? string(detail.artifactSlot);
  const version = revision(parameters.revision ?? detail.revision);
  const jobId = string(detail.jobId) ?? string(nested.jobId);
  const outputPath = string(parameters.path) ?? string(detail.path);
  const matches = (failure: MediaDependencyFailure) => failure.toolName === toolName && (
    toolName === 'materialize_asset' ? Boolean(outputPath && failure.path === outputPath) || failure.callId === callId
      : Boolean(slot && failure.artifactSlot === slot && version >= (failure.revision ?? 0)) || Boolean(jobId && failure.jobId === jobId) || failure.callId === callId
  );
  if (event.status === 'completed') {
    for (let index = failures.length - 1; index >= 0; index -= 1) if (matches(failures[index])) failures.splice(index, 1);
    return;
  }
  // A repeated failure replaces its previous message, while other revisions remain distinguishable.
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    const failure = failures[index];
    if (matches(failure) && (toolName !== 'request_media' || version === (failure.revision ?? 0))) failures.splice(index, 1);
  }
  failures.push({ code: string(detail.code) ?? 'MEDIA_TOOL_FAILED', message: string(detail.error) ?? event.summary ?? '媒体工具未完成', required: detail.required !== false && nested.required !== false,
    toolName, ...(slot ? { artifactSlot: slot, revision: version } : {}), ...(jobId ? { jobId } : {}), ...(outputPath ? { path: outputPath } : {}), callId, observedAt: Date.now() });
}

/** Job state is authoritative. The newest revision of an asset supersedes previous failures. */
export function resolveMediaCompletion(jobs: MediaJob[], toolFailures: MediaDependencyFailure[], scope: Scope): MediaCompletion {
  const scoped = jobs.filter((job) => job.rootRunId === scope.runId && job.sessionId === scope.sessionId);
  const latest = new Map<string, MediaJob>();
  const key = (job: MediaJob) => job.artifactSlot ? 'slot:' + job.artifactSlot : 'job:' + job.id;
  for (const job of scoped) {
    const previous = latest.get(key(job));
    if (!previous || job.revision > previous.revision || (job.revision === previous.revision && job.updatedAt >= previous.updatedAt)) latest.set(key(job), job);
  }
  const failures = toolFailures.filter((failure) => {
    if (!failure.required) return false;
    if (failure.toolName !== 'request_media') return true;
    const ownJob = failure.jobId ? scoped.find((job) => job.id === failure.jobId) : undefined;
    // Provider/job failures are represented below by the current durable state; conflicts are new unsatisfied requirements.
    if (ownJob && !['MEDIA_REQUEST_CONFLICT', 'MEDIA_INVALID_REQUEST'].includes(failure.code)) return false;
    const current = failure.artifactSlot ? latest.get('slot:' + failure.artifactSlot) : ownJob;
    if (current?.status === 'succeeded' && current.revision >= (failure.revision ?? 0)
      && Date.parse(current.updatedAt) >= (failure.observedAt ?? 0)) return false;
    // A more recent failed revision supplies the authoritative failure for this slot too.
    if (current && current.status !== 'succeeded' && current.revision >= (failure.revision ?? 0)) return false;
    return true;
  });
  for (const job of latest.values()) {
    if (!job.required || job.status === 'succeeded') continue;
    failures.push({ code: job.status === 'unknown' ? 'MEDIA_RESULT_UNKNOWN' : job.status === 'submitting' ? 'MEDIA_PENDING' : 'MEDIA_GENERATION_FAILED',
      message: job.error ?? (job.status === 'submitting' ? '所需素材仍在生成' : '所需素材尚未生成'), required: true, toolName: 'request_media', jobId: job.id,
      ...(job.artifactSlot ? { artifactSlot: job.artifactSlot } : {}), revision: job.revision });
  }
  const descriptions = [...new Set(failures.map((failure) => (failure.path ? '导出 ' + failure.path : failure.artifactSlot ? failure.artifactSlot : failure.jobId ? '生成任务 ' + failure.jobId : '媒体请求') + '：' + failure.message))];
  return { jobs: scoped, failures, blocked: failures.length > 0,
    ...(descriptions.length ? { notice: '所需媒体素材未完成，本轮任务尚未完整交付。\n' + descriptions.map((message) => '- ' + message).join('\n') } : {}) };
}
