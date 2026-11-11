import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ModelConfig } from '../models/ModelConfig';
import { getModelOperations } from '../models/ModelOperations';
import { snapshotModel } from '../models/ModelSnapshot';
import { BudgetExceededError } from '../routing/RunBudget';
import { normalizeMediaRequest, routeMediaRequest } from './MediaRouting';
import { ImageProviderError, OpenAIImagesProvider } from './providers/OpenAIImagesProvider';
import { MediaError, normalizeMediaArtifacts, type MediaArtifact, type MediaExecutionContext, type MediaJob, type MediaRequest, type MediaResult } from './MediaTypes';

export interface MediaServiceOptions { dataDir: string; models: { getAllModels(): ModelConfig[] }; fetch?: typeof fetch; }
function clone<T>(value: T): T { return structuredClone(value); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
}
function estimateCost(model: ModelConfig, usage: any): number | undefined {
  const rates = getModelOperations(model)['image.generate']?.pricing;
  if (!rates || !usage || typeof usage !== 'object') return undefined;
  const valid = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const text = usage.input_tokens_details?.text_tokens;
  const image = usage.input_tokens_details?.image_tokens;
  const output = usage.output_tokens_details?.image_tokens ?? usage.output_tokens;
  if (!valid(text) || !valid(image) || !valid(output)) return undefined;
  if ((text > 0 && rates.inputTextPerMillion === undefined) || (image > 0 && rates.inputImagePerMillion === undefined) || (output > 0 && rates.outputImagePerMillion === undefined)) return undefined;
  return (text * (rates.inputTextPerMillion ?? 0) + image * (rates.inputImagePerMillion ?? 0) + output * (rates.outputImagePerMillion ?? 0)) / 1_000_000;
}

/** Owns creation and assets independently of text model selection. No creation retry after an uncertain response. */
export class MediaExecutionService {
  private readonly directory: string;
  private readonly assetDirectory: string;
  private readonly jobs = new Map<string, MediaJob>();
  private readonly keys = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<MediaResult>>();
  private readonly deletedSessions = new Set<string>();
  private readonly provider: OpenAIImagesProvider;
  constructor(private readonly options: MediaServiceOptions) {
    this.directory = path.join(options.dataDir, 'media', 'jobs');
    this.assetDirectory = path.join(options.dataDir, 'media', 'assets');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.assetDirectory, { recursive: true, mode: 0o700 });
    this.provider = new OpenAIImagesProvider(options.fetch);
    for (const file of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      try {
        const filePath = path.join(this.directory, file);
        if (fs.statSync(filePath).size > 500_000) continue;
        const job = JSON.parse(fs.readFileSync(filePath, 'utf8')) as MediaJob;
        if (file !== job.id + '.json' || typeof job.rootRunId !== 'string' || typeof job.sessionId !== 'string' || !['submitting', 'succeeded', 'failed', 'unknown'].includes(job.status)) continue;
        job.request = normalizeMediaRequest(job.request);
        job.required = true;
        job.operation = job.request.operation;
        job.artifacts = normalizeMediaArtifacts(job.artifacts);
        if (!Array.isArray(job.attempts)) job.attempts = [];
        if (job.status === 'succeeded' && (!job.artifacts.length || job.artifacts.some((artifact) => !fs.existsSync(path.join(this.assetDirectory, artifact.fileName))))) {
          job.status = 'failed'; job.error = '已保存的媒体文件失效，不会自动重新生成'; this.persist(job);
        }
        if (job.status === 'submitting') {
          job.status = 'unknown'; job.error = '应用在图片请求完成前退出，上游结果未知；不会自动重新提交';
          for (const attempt of job.attempts) if (attempt.status === 'submitting') attempt.status = 'unknown';
          this.persist(job);
        }
        this.jobs.set(job.id, job); this.keys.set(this.key(job.request, job.rootRunId, job.sessionId), job.id);
      } catch { /* A damaged job must not stop the application or trigger generation. */ }
    }
  }
  private key(request: MediaRequest, rootRunId: string, sessionId: string): string {
    const slot = request.artifactSlot ?? createHash('sha256').update(canonical(request)).digest('hex');
    return canonical([sessionId, rootRunId, slot, request.revision ?? 0]);
  }
  private persist(job: MediaJob): void {
    job.updatedAt = new Date().toISOString();
    const target = path.join(this.directory, job.id + '.json'); const temporary = target + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify(job), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, target); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  private publish(job: MediaJob, context: MediaExecutionContext): void { this.persist(job); try { context.onJob?.(clone(job)); } catch { /* UI observers cannot change a paid task's outcome. */ } }
  getJob(id: string): MediaJob | undefined { const job = this.jobs.get(id); return job ? clone(job) : undefined; }
  listJobs(rootRunId?: string, sessionId?: string): MediaJob[] { return [...this.jobs.values()].filter((job) => (!rootRunId || job.rootRunId === rootRunId) && (!sessionId || job.sessionId === sessionId)).map(clone); }
  listArtifacts(rootRunId: string, sessionId?: string): MediaArtifact[] { return this.listJobs(rootRunId, sessionId).flatMap((job) => job.artifacts); }
  /** The host aborts the session first. Wait for any paid request to settle before removing its files. */
  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessions.add(sessionId);
    const jobs = [...this.jobs.values()].filter((job) => job.sessionId === sessionId);
    await Promise.allSettled(jobs.flatMap((job) => { const pending = this.inFlight.get(job.id); return pending ? [pending] : []; }));
    for (const job of jobs) {
      for (const artifact of job.artifacts) fs.rmSync(path.join(this.assetDirectory, artifact.fileName), { force: true });
      fs.rmSync(path.join(this.directory, job.id + '.json'), { force: true });
      this.jobs.delete(job.id); this.keys.delete(this.key(job.request, job.rootRunId, job.sessionId));
    }
  }
  private findAsset(id: string): MediaArtifact {
    for (const job of this.jobs.values()) { const artifact = job.artifacts.find((candidate) => candidate.id === id); if (artifact) return artifact; }
    throw new MediaError('MEDIA_ASSET_NOT_FOUND', '图片资产不存在');
  }
  getAssetPath(id: string): string {
    const artifact = this.findAsset(id);
    const target = path.join(this.assetDirectory, artifact.fileName);
    if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isFile()) throw new MediaError('MEDIA_ASSET_NOT_FOUND', '图片文件已失效');
    return target;
  }
  readAsset(id: string): { artifact: MediaArtifact; bytes: Buffer } { return { artifact: clone(this.findAsset(id)), bytes: fs.readFileSync(this.getAssetPath(id)) }; }
  exportAsset(id: string, targetRelativePath: string, projectRoot: string): { path: string; artifact: MediaArtifact } {
    if (!targetRelativePath || path.isAbsolute(targetRelativePath)) throw new MediaError('MEDIA_INVALID_PATH', '素材导出须为项目内相对路径');
    const root = fs.realpathSync(projectRoot); const target = path.resolve(root, targetRelativePath);
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new MediaError('MEDIA_INVALID_PATH', '素材导出路径超出项目');
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new MediaError('MEDIA_INVALID_PATH', '素材导出路径不能经过符号链接');
    }
    const { artifact, bytes } = this.readAsset(id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const resolvedParent = fs.realpathSync(path.dirname(target));
    const relativeParent = path.relative(root, resolvedParent);
    if (relativeParent === '..' || relativeParent.startsWith('..' + path.sep) || path.isAbsolute(relativeParent)) throw new MediaError('MEDIA_INVALID_PATH', '素材导出目录超出项目');
    if (fs.existsSync(target) && fs.lstatSync(target).isFile() && fs.readFileSync(target).equals(bytes)) return { path: relative.split(path.sep).join('/'), artifact };
    // Do not replace an existing project file through a generated-asset tool.
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    return { path: relative.split(path.sep).join('/'), artifact };
  }
  async execute(input: MediaRequest, context: MediaExecutionContext): Promise<MediaResult> {
    context.signal?.throwIfAborted();
    if (!context.rootRunId || !context.sessionId) throw new MediaError('MEDIA_INVALID_CONTEXT', '媒体请求缺少宿主运行身份');
    if (this.deletedSessions.has(context.sessionId)) throw new MediaError('MEDIA_SESSION_DELETED', '该会话已删除，不能创建媒体任务');
    const request = normalizeMediaRequest(input); const key = this.key(request, context.rootRunId, context.sessionId);
    const previous = this.keys.get(key);
    let job: MediaJob | undefined;
    if (previous) {
      job = this.jobs.get(previous)!;
      if (canonical(job.request) !== canonical(request)) throw new MediaError('MEDIA_REQUEST_CONFLICT', '同一素材位置的要求发生冲突，请先确认要求或明确增加 revision', { jobId: job.id });
      if (context.modelId && job.attempts.length && job.configurationId !== context.modelId) throw new MediaError('MEDIA_REQUEST_CONFLICT', '该素材任务已经由其他指定模型尝试，不能更改模型后复用同一 requestId/revision', { jobId: job.id, required: true });
      const running = this.inFlight.get(previous); if (running) return running;
      if (job.status === 'succeeded') return { job: clone(job), artifacts: clone(job.artifacts) };
      if (job.status === 'unknown') throw new MediaError('MEDIA_RESULT_UNKNOWN', job.error ?? '该媒体请求结果未知，不能自动重投', { jobId: job.id, required: true });
      if (job.status !== 'failed' || job.attempts.some((attempt) => attempt.status !== 'failed') || job.artifacts.length) throw new MediaError('MEDIA_PREVIOUS_FAILED', job.error ?? '该媒体请求已结束，请检查原因后明确创建新版本', { jobId: job.id, required: true });
      job.status = 'submitting'; delete job.error;
    } else {
      const now = new Date().toISOString();
      job = { id: randomUUID(), required: true, operation: request.operation, rootRunId: context.rootRunId, sessionId: context.sessionId, assistantMessageId: context.assistantMessageId, agentId: context.agentId, artifactSlot: request.artifactSlot, revision: request.revision ?? 0, request, status: 'submitting', attempts: [], artifacts: [], createdAt: now, updatedAt: now, costStatus: 'unknown' };
      this.jobs.set(job.id, job); this.keys.set(key, job.id);
    }
    const attemptsBeforeRouting = job.attempts.length;
    try {
      const allModels = this.options.models.getAllModels();
      if (context.modelId && !allModels.some((model) => model.id === context.modelId)) throw new MediaError('MODEL_OPERATION_MISMATCH', '指定的媒体模型不存在');
      let candidates = routeMediaRequest(request, context.modelId ? allModels.filter((model) => model.id === context.modelId) : allModels).filter((candidate) => context.quota?.isAvailable(candidate.model) ?? true);
      if (!candidates.length) throw new MediaError('MEDIA_QUOTA_EXHAUSTED', '兼容的媒体模型当前达到配额，请稍后重试');
      this.publish(job, context);
      const promise = this.perform(job, candidates, context);
      this.inFlight.set(job.id, promise);
      try { return await promise; } finally { this.inFlight.delete(job.id); }
    } catch (error) {
      // Keep validation/routing failures visible to the root scheduler so a required dependency cannot disappear.
      if (job.status === 'submitting' && job.attempts.length === attemptsBeforeRouting) {
        job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error); this.publish(job, context);
      }
      if (error instanceof MediaError) throw new MediaError(error.code, error.message, { ...(error.details && typeof error.details === 'object' ? error.details : {}), jobId: job.id, required: true });
      throw new MediaError('MEDIA_GENERATION_FAILED', error instanceof Error ? error.message : String(error), { jobId: job.id, required: true });
    }
  }
  private async perform(job: MediaJob, candidates: ReturnType<typeof routeMediaRequest>, context: MediaExecutionContext): Promise<MediaResult> {
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]; const model = candidate.model;
      const attemptIndex = job.attempts.length;
      let sent = false;
      const attempt = { configurationId: model.id, modelId: model.modelId, protocol: 'openai-images', modelSnapshot: snapshotModel(model), startedAt: new Date().toISOString(), status: 'submitting' as const, reason: candidate.reason };
      job.attempts.push(attempt);
      job.modelId = model.modelId; job.configurationId = model.id;
      job.estimatedCostUsd = candidate.estimatedCostUsd;
      try {
        context.signal?.throwIfAborted();
        context.quota?.reserve(model);
        this.publish(job, context);
        sent = true;
        const result = await this.provider.generate(model, candidate.request, context.signal);
        job.usage = result.usage;
        const usageEstimateUsd = estimateCost(model, result.usage);
        job.estimatedCostUsd = usageEstimateUsd ?? candidate.estimatedCostUsd;
        // Measured usage times user-configured rates is still an estimate, not a provider invoice.
        job.costStatus = job.estimatedCostUsd !== undefined ? 'estimated' : 'unknown';
        for (const image of result.images) {
          const id = randomUUID(), fileName = id + '.' + image.extension;
          const target = path.join(this.assetDirectory, fileName), temporary = target + '.tmp';
          try { fs.writeFileSync(temporary, image.bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, target); }
          finally { fs.rmSync(temporary, { force: true }); }
          job.artifacts.push({ id, kind: 'image', mimeType: image.mimeType, fileName, width: image.width, height: image.height, modelId: model.modelId, configurationId: model.id, jobId: job.id });
        }
        delete job.error;
        job.status = 'succeeded'; job.attempts[attemptIndex].status = 'succeeded'; this.publish(job, context);
        return { job: clone(job), artifacts: clone(job.artifacts) };
      } catch (error) {
        const safe = !sent || (error instanceof ImageProviderError && error.safeToRetry) || (error instanceof MediaError && error.code === 'MEDIA_INVALID_ENDPOINT');
        const message = error instanceof Error ? error.message : String(error);
        job.attempts[attemptIndex].status = safe ? 'failed' : 'unknown'; job.attempts[attemptIndex].error = message;
        job.error = message;
        const canTryAnother = sent || error instanceof BudgetExceededError || (error instanceof Error && (error as { code?: string }).code === 'BUDGET_EXCEEDED') || (error instanceof MediaError && error.code === 'MEDIA_INVALID_ENDPOINT') || Boolean(context.quota && !context.quota.isAvailable(model));
        if (safe && canTryAnother && index < candidates.length - 1 && !context.signal?.aborted) { this.publish(job, context); continue; }
        job.status = safe ? 'failed' : 'unknown'; this.publish(job, context);
        if (error instanceof MediaError) throw new MediaError(error.code, error.message, { ...(error.details && typeof error.details === 'object' ? error.details : {}), jobId: job.id, required: true });
        throw new MediaError(safe ? 'MEDIA_GENERATION_FAILED' : 'MEDIA_RESULT_UNKNOWN', message, { jobId: job.id });
      }
    }
    throw new MediaError('MEDIA_GENERATION_FAILED', '没有可执行的媒体候选');
  }
}
