/** Input includes ordinary, cache-read and cache-write tokens once each. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ModelRequestEstimate {
  estimatedInputTokens: number;
  maxOutputTokens: number;
}
