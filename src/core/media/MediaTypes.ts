import type { ModelConfig } from '../models/ModelConfig';
import type { ModelSnapshot } from '../models/ModelSnapshot';
export type MediaOperation = 'image.generate' | 'video.generate';
export type MediaFormat = 'png' | 'jpeg' | 'webp';
export interface MediaRequest {
  operation: MediaOperation;
  prompt: string;
  purpose?: string;
  artifactSlot?: string;
  revision?: number;
  size?: string;
  aspectRatio?: string;
  format?: MediaFormat;
  transparentBackground?: boolean;
  quality?: 'auto' | 'low' | 'medium' | 'high';
  durationSeconds?: number;
  preference?: 'quality' | 'cost' | 'speed';
}
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
export type MediaJobStatus = 'submitting' | 'succeeded' | 'failed' | 'unknown';
export interface MediaAttempt {
  configurationId: string;
  modelId: string;
  protocol: string;
  modelSnapshot?: ModelSnapshot;
  startedAt: string;
  status: 'submitting' | 'succeeded' | 'failed' | 'unknown';
  reason: string;
  error?: string;
}
export interface MediaJob {
  id: string;
  /** Every accepted media request represents a required task dependency in the first release. */
  required: true;
  operation: MediaOperation;
  modelId?: string;
  configurationId?: string;
  rootRunId: string;
  sessionId: string;
  assistantMessageId?: string;
  agentId?: string;
  artifactSlot?: string;
  revision: number;
  request: MediaRequest;
  status: MediaJobStatus;
  attempts: MediaAttempt[];
  artifacts: MediaArtifact[];
  createdAt: string;
  updatedAt: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  costStatus: 'unknown' | 'estimated' | 'actual';
  usage?: unknown;
  error?: string;
}
export interface MediaExecutionContext {
  rootRunId: string;
  sessionId: string;
  assistantMessageId?: string;
  agentId?: string;
  /** Strict explicit model override for this operation only, supplied by the host. */
  modelId?: string;
  signal?: AbortSignal;
  budget?: {
    reserve(id: string, estimatedCostUsd?: number): void;
    settle(id: string, costUsd?: number): void;
  };
  quota?: {
    isAvailable(model: ModelConfig): boolean;
    reserve(model: ModelConfig): void;
    record(modelId: string, usage?: { inputTokens?: number; outputTokens?: number }): void;
  };
  onJob?: (job: MediaJob) => void;
}
export interface MediaResult { job: MediaJob; artifacts: MediaArtifact[]; }
export class MediaError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); this.name = 'MediaError'; }
}
export interface GeneratedImage { bytes: Buffer; mimeType: string; extension: MediaFormat; width: number; height: number; }

/** Safe shared metadata normalization. File access always resolves the opaque asset id in the service. */
export function normalizeMediaArtifacts(value: unknown): MediaArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((item): MediaArtifact[] => {
    if (!item || typeof item !== 'object') return [];
    const a = item as Partial<MediaArtifact>;
    if (typeof a.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(a.id) || !['image', 'video'].includes(String(a.kind))) return [];
    if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(String(a.mimeType))) return [];
    const extension = a.mimeType === 'image/png' ? 'png' : a.mimeType === 'image/jpeg' ? 'jpeg' : a.mimeType === 'image/webp' ? 'webp' : 'mp4';
    if (a.kind === 'image' && !String(a.mimeType).startsWith('image/')) return [];
    if (a.kind === 'video' && !String(a.mimeType).startsWith('video/')) return [];
    if (a.fileName !== a.id + '.' + extension) return [];
    if ([a.modelId, a.configurationId, a.jobId].some((x) => typeof x !== 'string' || !x || x.length > 300)) return [];
    return [{ id: a.id, kind: a.kind!, mimeType: a.mimeType!, fileName: a.fileName, modelId: a.modelId!, configurationId: a.configurationId!, jobId: a.jobId!,
      ...(Number.isInteger(a.width) && a.width! > 0 && a.width! <= 32768 ? { width: a.width } : {}),
      ...(Number.isInteger(a.height) && a.height! > 0 && a.height! <= 32768 ? { height: a.height } : {}),
    }];
  });
}
