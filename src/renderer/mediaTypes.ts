export interface MediaArtifact {
  id: string;
  kind: 'image' | 'video';
  mimeType: string;
  fileName: string;
  width?: number;
  height?: number;
  modelId: string;
  configurationId: string;
  jobId: string;
}

export interface MediaJobSummary {
  id: string;
  status: 'queued' | 'submitting' | 'running' | 'downloading' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  operation: 'image.generate' | 'video.generate';
  modelId?: string;
  error?: string;
}

const statuses = new Set(['queued', 'submitting', 'running', 'downloading', 'succeeded', 'failed', 'unknown', 'cancelled']);
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
export const mediaAssetUrl = (id: string) => 'newai-media://asset/' + encodeURIComponent(id);

/** Keep metadata only: paths, remote URLs and bytes never enter messages. */
export function normalizeArtifacts(value: unknown): MediaArtifact[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 50).flatMap((entry): MediaArtifact[] => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Partial<MediaArtifact>;
    if (!safeId(item.id) || seen.has(item.id) || !['image', 'video'].includes(item.kind ?? '') || typeof item.mimeType !== 'string' || !/^(image|video)\/[a-zA-Z0-9.+-]+$/.test(item.mimeType) || typeof item.fileName !== 'string' || typeof item.modelId !== 'string' || typeof item.configurationId !== 'string' || !safeId(item.jobId)) return [];
    seen.add(item.id);
    return [{ id: item.id, kind: item.kind!, mimeType: item.mimeType, fileName: item.fileName.split(/[\\/]/).at(-1)!.slice(0, 200), modelId: item.modelId, configurationId: item.configurationId, jobId: item.jobId,
      ...(Number.isFinite(item.width) && item.width! > 0 ? { width: item.width } : {}), ...(Number.isFinite(item.height) && item.height! > 0 ? { height: item.height } : {}),
    }];
  });
}

export function normalizeMediaJobs(value: unknown): MediaJobSummary[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry): MediaJobSummary[] => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Partial<MediaJobSummary>;
    if (!safeId(item.id) || !statuses.has(item.status ?? '') || !['image.generate', 'video.generate'].includes(item.operation ?? '')) return [];
    return [{ id: item.id, status: item.status!, operation: item.operation!, ...(typeof item.modelId === 'string' ? { modelId: item.modelId } : {}), ...(typeof item.error === 'string' ? { error: item.error.slice(0, 500) } : {}) }];
  });
}
