import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/main/ipc/rateLimit';

describe('RateLimiter', () => {
  it('allows a burst up to the limit and rejects the next call in the window', () => {
    let now = 1_000;
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect([limiter.allow('first'), limiter.allow('first'), limiter.allow('first')]).toEqual([true, true, true]);
    expect(limiter.allow('first')).toBe(false);
    expect(limiter.retryAfterSeconds('first')).toBe(60);
    // Another sender has its own budget.
    expect(limiter.allow('second')).toBe(true);
  });

  it('reopens the window after it elapses', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 5_000, now: () => now });
    expect(limiter.allow('sender')).toBe(true);
    expect(limiter.allow('sender')).toBe(false);
    now = 4_999;
    expect(limiter.allow('sender')).toBe(false);
    now = 5_000;
    expect(limiter.allow('sender')).toBe(true);
    // One allowed call per window: the next call waits for the new window.
    expect(limiter.retryAfterSeconds('sender')).toBe(5);
  });

  it('resets one key or all keys on demand', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000 });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('b')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    limiter.reset('a');
    expect(limiter.allow('a')).toBe(true);
    limiter.reset();
    expect(limiter.allow('b')).toBe(true);
  });

  it('validates its configuration', () => {
    expect(() => new RateLimiter({ limit: 0, windowMs: 1_000 })).toThrow('限流上限');
    expect(() => new RateLimiter({ limit: 1, windowMs: Number.NaN })).toThrow('限流窗口');
  });
});
