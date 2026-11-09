import type { ModelConfig } from '../../src/core/models/ModelConfig';
export type EvalCheck =
  | { type: 'command'; run: string; expectExit: number }
  | { type: 'file-unchanged'; path: string }
  | { type: 'file-contains'; path: string; value: string }
  | { type: 'answer-contains'; value: string }
  | { type: 'max-tool-calls'; value: number }
  | { type: 'max-cost'; value: number }
  | { type: 'llm-judge'; modelId: string; rubric: string; minScore: number };
export interface EvalTask { id: string; tags: string[]; prompt: string; fixture: string; checks: EvalCheck[]; timeoutMs: number; directory: string; }
export interface EvalOptions {
  tasksDir?: string; resultsDir?: string; dataDir?: string; model?: string; tags?: string[];
  repeat?: number; baseline?: string; smoke?: boolean; signal?: AbortSignal;
  onProgress?(event: { type: string; [key: string]: unknown }): void;
  /** Explicit model injection for embedded callers; credentials are never included in reports. */
  modelConfig?: ModelConfig;
}
export interface CheckResult { type: EvalCheck['type']; passed: boolean; detail: string; usage?: { inputTokens: number; outputTokens: number; cost: number }; }
export interface EvalSample {
  taskId: string; tags: string[]; model: string; mode: 'smoke' | 'model'; iteration: number;
  modelSnapshot?: { configId: string; provider: string; modelId: string; costPer1kTokens?: { input: number; output: number } };
  passed: boolean; durationMs: number; toolCalls: number; cost: number | null;
  inputTokens: number | null; outputTokens: number | null; checks: CheckResult[]; error?: string;
}
export interface EvalGroup { runs: number; passed: number; passRate: number; meanDurationMs: number; meanToolCalls: number; meanCost: number | null; }
export interface EvalReport {
  schemaVersion: 1; createdAt: string; mode: 'smoke' | 'model'; passed: boolean;
  cancelled: boolean; expectedSamples: number;
  samples: EvalSample[]; summary: EvalGroup; byTag: Record<string, EvalGroup>; byModel: Record<string, EvalGroup>;
  regressions: string[]; jsonPath: string; markdownPath: string;
}
