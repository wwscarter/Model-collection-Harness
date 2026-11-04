import fs from 'node:fs';
import path from 'node:path';

export type GrowthTaskType = 'code' | 'reasoning' | 'analysis' | 'review' | 'creative' | 'general' | string;

export interface RoutingFeedback {
  modelId: string;
  taskType: GrowthTaskType;
  success?: boolean;
  actualCost?: number;
  estimatedCost?: number;
  actualLatency?: number;
  estimatedLatency?: number;
  auditApproval?: boolean;
  qualityScore?: number;
  userSatisfaction?: number;
  completed?: boolean;
  timestamp?: Date | string;
}

export interface ModelPerformanceProfile {
  modelId: string;
  taskType: GrowthTaskType;
  sampleCount: number;
  successRate: number;
  avgCost: number;
  avgLatency: number;
  avgQualityScore: number;
  taskCompletionRate: number;
  lastUpdated: Date;
}

export interface GrowthEngineOptions {
  /** Persistence is optional so the engine remains easy to embed and test. */
  storagePath?: string;
  /** EMA learning rate. 0.1 follows the roadmap's sliding-average example. */
  learningRate?: number;
}

interface SerializedProfile extends Omit<ModelPerformanceProfile, 'lastUpdated'> { lastUpdated: string; }

/**
 * Learns from completed tasks without changing model configuration directly.
 * The router can use getRoutingAdjustment() as a bounded multiplier or use rankModels().
 */
export class GrowthEngine {
  private readonly profiles = new Map<string, ModelPerformanceProfile>();
  private readonly storagePath?: string;
  private readonly alpha: number;

  constructor(options: GrowthEngineOptions = {}) {
    this.storagePath = options.storagePath;
    this.alpha = Math.min(1, Math.max(0.001, Number.isFinite(options.learningRate) ? options.learningRate! : 0.1));
    this.load();
  }

  recordFeedback(feedback: RoutingFeedback): ModelPerformanceProfile {
    if (typeof feedback.modelId !== 'string' || !feedback.modelId.trim()) throw new Error('modelId is required for feedback');
    if (typeof feedback.taskType !== 'string' || !feedback.taskType.trim()) throw new Error('taskType is required for feedback');
    const key = this.key(feedback.modelId, feedback.taskType);
    const old = this.profiles.get(key);
    const quality = this.qualityFromFeedback(feedback, old?.avgQualityScore);
    const completed = feedback.completed ?? feedback.success;
    const sampleCount = (old?.sampleCount ?? 0) + 1;
    const profile: ModelPerformanceProfile = old
      ? {
          ...old,
          sampleCount,
          successRate: this.ema(old.successRate, feedback.success === undefined ? old.successRate : feedback.success ? 1 : 0),
          avgCost: this.ema(old.avgCost, this.nonNegative(feedback.actualCost, old.avgCost)),
          avgLatency: this.ema(old.avgLatency, this.nonNegative(feedback.actualLatency, old.avgLatency)),
          avgQualityScore: this.ema(old.avgQualityScore, quality),
          taskCompletionRate: this.ema(old.taskCompletionRate, completed === undefined ? old.taskCompletionRate : completed ? 1 : 0),
          lastUpdated: this.timestamp(feedback.timestamp),
        }
      : {
          modelId: feedback.modelId,
          taskType: feedback.taskType,
          sampleCount,
          successRate: feedback.success === undefined ? 0.5 : feedback.success ? 1 : 0,
          avgCost: this.nonNegative(feedback.actualCost, 0),
          avgLatency: this.nonNegative(feedback.actualLatency, 0),
          avgQualityScore: quality,
          taskCompletionRate: completed === undefined ? 0.5 : completed ? 1 : 0,
          lastUpdated: this.timestamp(feedback.timestamp),
        };
    this.profiles.set(key, profile);
    this.persist();
    return this.clone(profile);
  }

  getProfile(modelId: string, taskType: GrowthTaskType = 'general'): ModelPerformanceProfile | undefined {
    const profile = this.profiles.get(this.key(modelId, taskType)) ?? this.profiles.get(this.key(modelId, 'general'));
    return profile ? this.clone(profile) : undefined;
  }

  getProfiles(): ModelPerformanceProfile[] {
    return [...this.profiles.values()].sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime()).map((profile) => this.clone(profile));
  }

  /** Returns a bounded multiplier. New/unknown models receive a neutral value. */
  getRoutingAdjustment(modelId: string, taskType: GrowthTaskType = 'general'): number {
    const profile = this.getProfile(modelId, taskType);
    if (!profile || profile.sampleCount === 0) return 1;
    const quality = profile.avgQualityScore / 100;
    const reliability = (profile.successRate + profile.taskCompletionRate) / 2;
    const costFactor = profile.avgCost > 0 ? 1 / (1 + profile.avgCost) : 1;
    return Math.min(1.35, Math.max(0.65, 0.55 + reliability * 0.3 + quality * 0.15 + costFactor * 0.1));
  }

  rankModels(modelIds: string[], taskType: GrowthTaskType = 'general'): string[] {
    return [...modelIds].sort((left, right) => this.getRoutingAdjustment(right, taskType) - this.getRoutingAdjustment(left, taskType));
  }

  clear(): void {
    this.profiles.clear();
    if (this.storagePath) {
      try { fs.rmSync(this.storagePath, { force: true }); } catch { /* best effort */ }
    }
  }

  private key(modelId: string, taskType: GrowthTaskType): string { return `${modelId}\u0000${taskType}`; }
  private ema(previous: number, next: number): number { return previous * (1 - this.alpha) + next * this.alpha; }
  private nonNegative(value: number | undefined, fallback: number): number { return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback; }
  private timestamp(value: Date | string | undefined): Date { const date = value ? new Date(value) : new Date(); return Number.isNaN(date.getTime()) ? new Date() : date; }
  private qualityFromFeedback(feedback: RoutingFeedback, fallback = 50): number {
    const values: number[] = [];
    if (feedback.qualityScore !== undefined && Number.isFinite(feedback.qualityScore)) values.push(Math.min(100, Math.max(0, feedback.qualityScore)));
    if (feedback.auditApproval !== undefined) values.push(feedback.auditApproval ? 100 : 0);
    if (feedback.userSatisfaction !== undefined && Number.isFinite(feedback.userSatisfaction)) values.push(Math.min(100, Math.max(0, feedback.userSatisfaction * 20)));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : feedback.success === false ? 0 : fallback;
  }

  private load(): void {
    if (!this.storagePath || !fs.existsSync(this.storagePath)) return;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        if (!value || typeof value !== 'object') continue;
        const item = value as SerializedProfile;
        const lastUpdated = new Date(item.lastUpdated);
        if (typeof item.modelId !== 'string' || !item.modelId.trim() || typeof item.taskType !== 'string' || !item.taskType.trim()
          || !Number.isInteger(item.sampleCount) || item.sampleCount < 0 || !Number.isFinite(lastUpdated.getTime())
          || ![item.successRate, item.taskCompletionRate].every((rate) => Number.isFinite(rate) && rate >= 0 && rate <= 1)
          || ![item.avgCost, item.avgLatency].every((value) => Number.isFinite(value) && value >= 0)
          || !Number.isFinite(item.avgQualityScore) || item.avgQualityScore < 0 || item.avgQualityScore > 100) continue;
        this.profiles.set(this.key(item.modelId, item.taskType), { ...item, lastUpdated });
      }
    } catch {
      // Corrupt learning data should never prevent the agent from starting.
      this.profiles.clear();
    }
  }

  private persist(): void {
    if (!this.storagePath) return;
    const directory = path.dirname(this.storagePath);
    fs.mkdirSync(directory, { recursive: true });
    const data = [...this.profiles.values()].map((profile): SerializedProfile => ({ ...profile, lastUpdated: profile.lastUpdated.toISOString() }));
    const temporary = `${this.storagePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.storagePath);
  }

  private clone(profile: ModelPerformanceProfile): ModelPerformanceProfile { return { ...profile, lastUpdated: new Date(profile.lastUpdated) }; }
}
