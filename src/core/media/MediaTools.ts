import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MediaExecutionService } from './MediaExecutionService';
import { MediaError, type MediaExecutionContext, type MediaJob, type MediaRequest } from './MediaTypes';

const text = (result: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result, ...(isError ? { isError: true } : {}) });
function failure(error: unknown, required = false) { return text({ code: error instanceof MediaError ? error.code : 'MEDIA_TOOL_FAILED', error: error instanceof Error ? error.message : String(error), ...(required ? { required: true } : {}), ...(error instanceof MediaError && error.details ? { details: error.details } : {}) }, true); }
const literal = <T extends string>(values: T[]) => Type.Union(values.map((value) => Type.Literal(value)));
function summary(job: MediaJob) { return { required: job.required, status: job.status, jobId: job.id, operation: job.operation, artifacts: job.artifacts, modelId: job.modelId, configurationId: job.configurationId, artifactSlot: job.artifactSlot, revision: job.revision, costStatus: job.costStatus, estimatedCostUsd: job.estimatedCostUsd, ...(job.error ? { error: job.error } : {}) }; }

/** Host-scoped tools: model input can describe work, never impersonate another run or choose credentials. */
export function createMediaTools(service: MediaExecutionService, context: MediaExecutionContext, options: { projectRoot?: string; allowExport?: boolean } = {}): ToolDefinition[] {
  const tools = [defineTool({
    name: 'request_media', label: '生成任务素材',
    description: 'Generate a real image through the application media router. Any worker may submit a complete media requirement; the application chooses an enabled image endpoint. You choose generation parameters and assess the actual returned image dimensions and format against the task. The endpoint decides parameter support; no local capability declaration is required. Use a stable artifactSlot for the same logical asset and revision=0; repeated requests reuse it. Change revision only when a new version is explicitly needed. Returns real saved asset references and actual metadata; a succeeded job means a valid image was saved, not that all task requirements were met. Never invent image URLs. Video protocol is not connected yet and reports unavailable. Does not write project files.',
    promptSnippet: 'Request a real image asset; the application chooses the image model dynamically',
    parameters: Type.Object({
      operation: literal(['image.generate', 'video.generate']),
      prompt: Type.String({ minLength: 1, maxLength: 32000 }),
      artifactSlot: Type.String({ minLength: 1, maxLength: 160, description: 'Stable logical asset slot, e.g. landing.hero. Reuse across retries and workers.' }),
      purpose: Type.Optional(Type.String({ maxLength: 2000 })), revision: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
      size: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Optional endpoint size parameter, e.g. 1920x1080 or auto. Sent unchanged; the provider decides support.' })),
      minSize: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Desired minimum dimensions included in the prompt. The application does not choose a size tier or enforce the result.' })),
      aspectRatio: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Desired aspect ratio included in the generation prompt.' })),
      format: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Optional output_format parameter passed to the endpoint.' })),
      quality: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Optional quality parameter passed to the endpoint.' })),
      transparentBackground: Type.Optional(Type.Boolean()), durationSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), preference: Type.Optional(literal(['quality', 'cost', 'speed'])),
    }),
    async execute(_id, input, signal) {
      try { const result = await service.execute(input as MediaRequest, { ...context, signal: signal && context.signal ? AbortSignal.any([signal, context.signal]) : signal ?? context.signal }); return text(summary(result.job)); }
      catch (error) { return failure(error, true); }
    },
  }), defineTool({
    name: 'get_media_job', label: '查询素材状态',
    description: 'Inspect a saved media job from this conversation. This never starts another generation. Unknown creation results must not be automatically submitted again.',
    parameters: Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 100 }) }),
    async execute(_id, input) {
      const job = service.getJob(input.jobId);
      return job && job.sessionId === context.sessionId ? text(summary(job)) : failure(new MediaError('MEDIA_JOB_NOT_FOUND', '当前会话中没有该媒体任务'));
    },
  })] as ToolDefinition[];
  if (options.allowExport && options.projectRoot) tools.push(defineTool({
    name: 'materialize_asset', label: '导出素材到项目',
    description: 'Copy an existing generated asset from this conversation into a new project-relative path. Does not generate again, cannot overwrite a different existing file, and returns the actual path for code references.',
    parameters: Type.Object({ assetId: Type.String({ minLength: 1, maxLength: 100 }), path: Type.String({ minLength: 1, maxLength: 1000 }) }),
    async execute(_id, input, signal) {
      try {
        signal?.throwIfAborted();
        const asset = service.readAsset(input.assetId).artifact; const job = service.getJob(asset.jobId);
        if (!job || job.sessionId !== context.sessionId) throw new MediaError('MEDIA_ASSET_NOT_FOUND', '当前会话中没有该媒体资产');
        return text(service.exportAsset(input.assetId, input.path, options.projectRoot!));
      } catch (error) { return failure(error, true); }
    },
  }) as ToolDefinition);
  return tools;
}
