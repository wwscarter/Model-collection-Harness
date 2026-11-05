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
  maxCost: number;
  maxDurationMs: number;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(label + '必须是有限的非负数');
  return value;
}

/** Application estimate guard; provider billing may differ from configured token rates. */
export class RunBudget {
  private cost = 0;
  private tokens = 0;
  private readonly startedAt: number;
  private readonly maxCost: number;
  private readonly maxDurationMs: number;
  private readonly maxTokens: number;
  private readonly now: () => number;

  constructor(options: RunBudgetOptions) {
    this.maxCost = nonNegative(options.maxCost, '成本预算');
    this.maxDurationMs = Math.max(1, nonNegative(options.maxDurationMs, '时间预算'));
    this.maxTokens = Math.max(1, nonNegative(options.maxTokens ?? Number.MAX_SAFE_INTEGER, 'Token 预算'));
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  assertAvailable(estimatedCost = 0): void {
    const elapsed = this.now() - this.startedAt;
    if (elapsed > this.maxDurationMs) throw new BudgetExceededError(`本轮运行已超过 ${Math.round(this.maxDurationMs / 1000)} 秒预算`);
    if (this.cost + nonNegative(estimatedCost, '预估费用') > this.maxCost) throw new BudgetExceededError(`本轮运行已超过成本预算（$${this.maxCost.toFixed(2)}）`);
    if (this.tokens > this.maxTokens) throw new BudgetExceededError('本轮运行已超过 Token 预算');
  }

  add(usage: { cost?: number; tokens?: number }): void {
    const cost = nonNegative(usage.cost ?? 0, '使用费用');
    const tokens = nonNegative(usage.tokens ?? 0, '使用 Token');
    const nextCost = nonNegative(this.cost + cost, '累计费用');
    const nextTokens = nonNegative(this.tokens + tokens, '累计 Token');
    this.cost = nextCost;
    this.tokens = nextTokens;
  }

  /** Cap the next request by configured rates per 1K tokens before any API call. */
  capOutputTokens(inputTokens: number, requestedOutput: number, rates: { input: number; output: number }, reservedCost = 0): number {
    this.assertAvailable();
    const input = Math.ceil(nonNegative(inputTokens, '预估输入 Token'));
    const requested = Math.floor(nonNegative(requestedOutput, '输出 Token'));
    const inputRate = nonNegative(rates.input, '输入单价');
    const outputRate = nonNegative(rates.output, '输出单价');
    const reserved = nonNegative(reservedCost, '预留费用');
    const moneyForOutput = this.maxCost - this.cost - reserved - input * inputRate / 1000;
    const byMoney = outputRate === 0 ? (moneyForOutput >= 0 ? requested : 0)
      : Math.floor((moneyForOutput * 1000 / outputRate) + 1e-9);
    const byTokens = Math.floor(this.maxTokens - this.tokens - input);
    const allowed = Math.min(requested, byMoney, byTokens);
    if (allowed < 1) throw new BudgetExceededError(`剩余预估费用不足以发起下一次模型请求（上限 $${this.maxCost.toFixed(2)}）`);
    return allowed;
  }

  snapshot(): RunBudgetSnapshot {
    return {
      cost: this.cost,
      tokens: this.tokens,
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      costRemaining: Math.max(0, this.maxCost - this.cost),
      maxCost: this.maxCost,
      maxDurationMs: this.maxDurationMs,
    };
  }
}
