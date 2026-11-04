/** Retry only provider/transient failures; auth, content and tool errors are not fallback candidates. */
export function isRetryableProviderError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /(?:\b429\b|\b5\d\d\b|timeout|timed out|超时|econnreset|econnrefused|socket hang up|fetch failed|network|terminated|overloaded|temporarily unavailable)/.test(message);
}

/** A fallback is safe only before any user-visible text or tool side effect. */
export function shouldFallback(input: { index: number; total: number; emittedText: boolean; emittedTool: boolean; error: unknown }): boolean {
  return input.index < input.total - 1 && !input.emittedText && !input.emittedTool && isRetryableProviderError(input.error);
}
