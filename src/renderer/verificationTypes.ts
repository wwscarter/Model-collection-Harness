export type VerificationMode = 'off' | 'quick' | 'full';
export type VerificationStatus = 'passed' | 'failed' | 'unverified' | 'skipped' | 'cancelled' | 'budget_limit';
export interface SessionVerificationEvent {
  sessionId: string;
  assistantMessageId?: string;
  phase: 'checking' | 'repair' | 'completed';
  status?: VerificationStatus;
  summary?: string;
}
