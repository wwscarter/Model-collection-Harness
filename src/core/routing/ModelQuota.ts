import type { ModelConfig } from '@core/models/ModelConfig';
import type { ModelMetrics } from '@core/observability/ObservabilityEngine';

export interface MetricsLike {
  getModelMetrics(range?: { from?: Date | string; to?: Date | string }): ModelMetrics[];
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
      const used = this.metrics.getModelMetrics({ from: start, to: new Date(now) })
        .find((entry) => entry.modelId === id)?.totalTokens ?? 0;
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
}
