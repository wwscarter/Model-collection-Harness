export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(message: string) { super(message); this.name = 'BudgetExceededError'; }
}

export interface RunBudgetOptions {
  maxCost: number;
  maxDurationMs: number;
  maxTokens?: number;
  now?: () => number;
}

export interface RunBudgetSnapshot {
  cost: number;
  tokens: number;
  elapsedMs: number;
  costRemaining: number;
}

/** Hard per-run guard shared by planning, collaboration, execution and verification. */
export class RunBudget {
  private cost = 0;
  private tokens = 0;
  private readonly startedAt: number;
  private readonly maxCost: number;
  private readonly maxDurationMs: number;
  private readonly maxTokens: number;
  private readonly now: () => number;

  constructor(options: RunBudgetOptions) {
    this.maxCost = Math.max(0, options.maxCost);
    this.maxDurationMs = Math.max(1, options.maxDurationMs);
    this.maxTokens = Math.max(1, options.maxTokens ?? Number.MAX_SAFE_INTEGER);
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  assertAvailable(estimatedCost = 0): void {
    const elapsed = this.now() - this.startedAt;
    if (elapsed > this.maxDurationMs) throw new BudgetExceededError(`本轮运行已超过 ${Math.round(this.maxDurationMs / 1000)} 秒预算`);
    if (this.cost + Math.max(0, estimatedCost) > this.maxCost) throw new BudgetExceededError(`本轮运行已超过成本预算（$${this.maxCost.toFixed(2)}）`);
    if (this.tokens > this.maxTokens) throw new BudgetExceededError('本轮运行已超过 Token 预算');
  }

  add(usage: { cost?: number; tokens?: number }): void {
    this.cost += Math.max(0, usage.cost ?? 0);
    this.tokens += Math.max(0, usage.tokens ?? 0);
  }

  snapshot(): RunBudgetSnapshot {
    return {
      cost: this.cost,
      tokens: this.tokens,
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      costRemaining: Math.max(0, this.maxCost - this.cost),
    };
  }
}
