import type { ModelConfig } from '@core/models/ModelConfig';
import type { ModelMetrics } from '@core/observability/ObservabilityEngine';

export interface MetricsLike {
  getModelMetrics(range?: { from?: Date | string; to?: Date | string }): ModelMetrics[];
  getModelTokenUsage?(modelId: string, range?: { from?: Date | string; to?: Date | string }): number;
}

/**
 * In-process RPM limiter plus a daily token check backed by completed metrics.
 * It is intentionally conservative: exhausted models are removed from routing
 * until the rolling window/day recovers.
 */
export class ModelQuota {
  private readonly requests = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly metrics: MetricsLike, now: () => number = () => Date.now()) {
    this.now = now;
  }

  isAvailable(model: ModelConfig): boolean {
    const now = this.now();
    const id = model.id;
    if (model.rateLimit.requestsPerMinute > 0) {
      const recent = (this.requests.get(id) ?? []).filter((timestamp) => timestamp > now - 60_000);
      this.requests.set(id, recent);
      if (recent.length >= model.rateLimit.requestsPerMinute) return false;
    }
    if (model.rateLimit.tokensPerDay > 0) {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const range = { from: start, to: new Date(now) };
      const used = this.metrics.getModelTokenUsage
        ? this.metrics.getModelTokenUsage(id, range)
        : this.metrics.getModelMetrics(range).find((entry) => entry.modelId === id)?.totalTokens ?? 0;
      if (used >= model.rateLimit.tokensPerDay) return false;
    }
    return true;
  }

  record(modelId: string): void {
    const now = this.now();
    const recent = (this.requests.get(modelId) ?? []).filter((timestamp) => timestamp > now - 60_000);
    recent.push(now);
    this.requests.set(modelId, recent);
  }

  /** Check and count the request together immediately before starting a call. */
  reserve(model: ModelConfig): void {
    if (!this.isAvailable(model)) throw new Error(`模型「${model.name}」已达到速率或每日配额，请稍后再试`);
    this.record(model.id);
  }
}
