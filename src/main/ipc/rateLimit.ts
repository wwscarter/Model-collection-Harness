/**
 * Fixed-window counter for renderer-triggered work that spends money or CPU.
 *
 * The renderer is our own page, but it is still the least trusted process:
 * injected script or a render loop bug should not be able to start unbounded
 * model runs. Limits are deliberately generous so normal clicking never hits
 * them; only a runaway caller does.
 */
export interface RateLimitOptions {
  /** Allowed calls per window per key. */
  limit: number;
  windowMs: number;
  now?: () => number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly now: () => number;

  constructor(private readonly options: RateLimitOptions) {
    if (!Number.isFinite(options.limit) || options.limit < 1) throw new Error('限流上限必须是正整数');
    if (!Number.isFinite(options.windowMs) || options.windowMs < 1) throw new Error('限流窗口必须是正数');
    this.now = options.now ?? (() => Date.now());
  }

  /** Returns true when the call is allowed, and counts it. */
  allow(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      // A new window replaces the old one. Bound the map so arbitrary keys
      // cannot grow it without limit.
      if (!bucket && this.buckets.size >= 256) this.prune(now);
      this.buckets.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return true;
    }
    if (bucket.count >= this.options.limit) return false;
    bucket.count += 1;
    return true;
  }

  /** Seconds until `key` may call again; 0 when it is not limited right now. */
  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const remaining = bucket.resetAt - this.now();
    return remaining > 0 && bucket.count >= this.options.limit ? Math.ceil(remaining / 1_000) : 0;
  }

  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) if (now >= bucket.resetAt) this.buckets.delete(key);
  }
}
