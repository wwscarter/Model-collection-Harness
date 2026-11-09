export type VerifyMode = 'off' | 'quick' | 'full';
export interface VerifyCommand { id: string; label: string; command: string; phase: 'quick' | 'full' }
export interface ResolvedVerifyCommands { projectRoot: string; fingerprint: string; commands: VerifyCommand[]; diagnostics: string[] }
export interface ProjectVerifyConfig {
  version: 1;
  mode: VerifyMode;
  timeoutMs: number;
  maxRepairRounds: number;
  commands: VerifyCommand[];
  manifestFingerprint: string;
  confirmedAt: string;
}
export interface VerifyExecutionResult { exitCode: number | null; output: string; durationMs: number; timedOut?: boolean; cancelled?: boolean }
export interface FailureDiagnostic { file?: string; line?: number; column?: number; message: string }
export interface VerificationCommandRecord { command: VerifyCommand; result: VerifyExecutionResult; diagnostics: FailureDiagnostic[] }
export interface VerificationAttempt { round: number; commands: VerificationCommandRecord[]; status: 'passed' | 'failed' | 'unverified' }
export type VerificationStatus = 'passed' | 'failed' | 'unverified' | 'skipped' | 'cancelled' | 'budget_limit';
export interface VerificationOutcome { status: VerificationStatus; attempts: VerificationAttempt[]; repairRounds: number; changedFiles: string[]; summary: string; reason?: string }
export type VerificationEvent =
  | { type: 'start'; round: number; changedFiles: string[] }
  | { type: 'command-start'; round: number; command: VerifyCommand }
  | { type: 'command-end'; round: number; record: VerificationCommandRecord }
  | { type: 'repair'; round: number; feedback: string }
  | { type: 'finish'; outcome: VerificationOutcome };
export interface VerificationTurn { content: string; stopReason?: string }
export interface VerificationTurnDecision { feedback?: string; summary?: string }
export interface VerifyConfigUnavailable { unavailable: string }
export interface VerificationLoopOptions {
  projectRoot: string;
  getConfig(signal?: AbortSignal, context?: { changedFiles: string[] }): Promise<ProjectVerifyConfig | VerifyConfigUnavailable | undefined>;
  execute(command: VerifyCommand, context: { signal?: AbortSignal; timeoutMs: number; round: number }): Promise<VerifyExecutionResult>;
  assertBudget?(): void;
  onEvent?(event: VerificationEvent): void;
}
