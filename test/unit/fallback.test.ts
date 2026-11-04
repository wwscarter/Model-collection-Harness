import { describe, expect, it } from 'vitest';
import { isRetryableProviderError, shouldFallback } from '../../src/core/routing/Fallback';

describe('fallback policy', () => {
  it('retries transient provider errors', () => {
    for (const message of ['HTTP 429 rate limit', '503 upstream unavailable', 'request timeout', 'fetch failed']) {
      expect(isRetryableProviderError(new Error(message)), message).toBe(true);
    }
    for (const message of ['401 invalid api key', 'content policy violation', '用户拒绝了这次工具调用']) {
      expect(isRetryableProviderError(new Error(message)), message).toBe(false);
    }
  });

  it('does not retry after visible text or a tool side effect', () => {
    const error = new Error('503');
    expect(shouldFallback({ index: 0, total: 2, emittedText: false, emittedTool: false, error })).toBe(true);
    expect(shouldFallback({ index: 1, total: 2, emittedText: false, emittedTool: false, error })).toBe(false);
    expect(shouldFallback({ index: 0, total: 2, emittedText: true, emittedTool: false, error })).toBe(false);
    expect(shouldFallback({ index: 0, total: 2, emittedText: false, emittedTool: true, error })).toBe(false);
  });
});
