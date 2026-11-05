import { describe, expect, it } from 'vitest';
import { BudgetExceededError, RunBudget } from '../../src/core/routing/RunBudget';

describe('RunBudget request caps', () => {
  it('subtracts observed usage and estimated input before capping the next output', () => {
    const budget = new RunBudget({ maxCost: 0.01, maxDurationMs: 1000 });
    budget.add({ cost: 0.002, tokens: 100 });
    expect(budget.capOutputTokens(100, 1000, { input: 0.01, output: 0.02 })).toBe(350);
    expect(budget.snapshot()).toMatchObject({ cost: 0.002, tokens: 100, costRemaining: 0.008, maxCost: 0.01, maxDurationMs: 1000 });
  });

  it('accounts for other pending requests without charging their reserved estimate', () => {
    const budget = new RunBudget({ maxCost: 0.01, maxDurationMs: 1000 });
    budget.add({ cost: 0.002 });
    expect(budget.capOutputTokens(100, 1000, { input: 0.01, output: 0.02 }, 0.003)).toBe(200);
    expect(() => budget.capOutputTokens(100, 1000, { input: 0.01, output: 0.02 }, 0.007)).toThrow('剩余预估费用不足');
    expect(budget.snapshot().cost).toBe(0.002);
  });

  it('rejects a request when the estimated input and one output token cannot fit', () => {
    const budget = new RunBudget({ maxCost: 0.001, maxDurationMs: 1000 });
    expect(() => budget.capOutputTokens(100, 100, { input: 0.01, output: 0.01 })).toThrow(BudgetExceededError);
    expect(budget.snapshot().cost).toBe(0);
  });

  it('supports zero-priced output and fully local inference without dividing by zero', () => {
    const budget = new RunBudget({ maxCost: 0.001, maxDurationMs: 1000 });
    expect(budget.capOutputTokens(100, 999, { input: 0.01, output: 0 })).toBe(999);
    expect(() => budget.capOutputTokens(101, 999, { input: 0.01, output: 0 })).toThrow(BudgetExceededError);
    const local = new RunBudget({ maxCost: 0, maxDurationMs: 1000 });
    expect(local.capOutputTokens(1000, 500, { input: 0, output: 0 })).toBe(500);
    expect(() => local.capOutputTokens(1, 10, { input: 0, output: 0 }, 0.001)).toThrow(BudgetExceededError);
  });

  it('also caps by the remaining token allowance and checks the deadline', () => {
    let now = 0;
    const budget = new RunBudget({ maxCost: 1, maxDurationMs: 1000, maxTokens: 100, now: () => now });
    budget.add({ tokens: 20 });
    expect(budget.capOutputTokens(30, 1000, { input: 0, output: 0 })).toBe(50);
    expect(() => budget.capOutputTokens(80, 1, { input: 0, output: 0 })).toThrow(BudgetExceededError);
    now = 1001;
    expect(() => budget.capOutputTokens(1, 1, { input: 0, output: 0 })).toThrow('秒预算');
  });

  it.each([NaN, Infinity, -1])('rejects invalid monetary inputs %s without changing committed usage', (value) => {
    expect(() => new RunBudget({ maxCost: value, maxDurationMs: 1000 })).toThrow();
    const budget = new RunBudget({ maxCost: 1, maxDurationMs: 1000 });
    expect(() => budget.add({ cost: value, tokens: 1 })).toThrow();
    expect(() => budget.capOutputTokens(10, 10, { input: value, output: 0 })).toThrow();
    expect(() => budget.capOutputTokens(10, 10, { input: 0, output: value })).toThrow();
    expect(() => budget.capOutputTokens(10, 10, { input: 0, output: 0 }, value)).toThrow();
    expect(budget.snapshot()).toMatchObject({ cost: 0, tokens: 0 });
  });
});
