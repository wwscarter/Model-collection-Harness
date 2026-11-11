import type { SessionRecord } from '@core/storage/SessionStorage';
import type { MediaExecutionService } from '@core/media/MediaExecutionService';

/** Job records survive renderer crashes and cannot be erased by a stale session save. */
export function restoreSessionMedia(record: SessionRecord | undefined, media?: MediaExecutionService): SessionRecord | undefined {
  if (!record || !media) return record;
  const jobs = media.listJobs().filter((job) => job.sessionId === record.id);
  if (!jobs.length) return record;
  const messages = [...(record.messages ?? [])];
  for (const job of jobs) {
    const id = job.assistantMessageId ?? job.rootRunId + '-assistant';
    let index = messages.findIndex((message) => message.id === id && message.role === 'assistant');
    if (index < 0) {
      messages.push({ id, role: 'assistant', content: job.status === 'succeeded' ? '素材已生成并保存。' : job.error ?? '素材生成尚未完成' });
      index = messages.length - 1;
    }
    const current = messages[index];
    const artifacts = [...(current.artifacts ?? []).filter((asset) => asset.jobId !== job.id), ...job.artifacts];
    const mediaJobs = [...(current.mediaJobs ?? []).filter((item) => item.id !== job.id), { id: job.id, status: job.status, operation: job.operation, modelId: job.modelId, error: job.error }];
    messages[index] = { ...current, artifacts, mediaJobs };
  }
  return { ...record, messages };
}
