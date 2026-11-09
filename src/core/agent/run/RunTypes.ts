import type { AuditLog } from '@core/audit/AuditLog';
import type { CodeAuditor } from '@core/audit/CodeAuditor';
import type { ContextTurn } from '@core/context/ContextAssembler';
import type { GrowthEngine } from '@core/growth/GrowthEngine';
import type { RoutingObservation } from '@core/growth/RoutingLearningStore';
import type { MemoryStore } from '@core/memory/MemoryStore';
import type { ModelConfig } from '@core/models/ModelConfig';
import type { ModelRegistry } from '@core/models/ModelRegistry';
import type { ObservabilityEngine } from '@core/observability/ObservabilityEngine';
import type { ProjectContextResult } from '@core/project/ProjectContext';
import type { ModelProvider, ModelResponse } from '@core/providers/ModelProvider';
import type { ModelQuota } from '@core/routing/ModelQuota';
import type { ModelRequestEstimate, ModelUsage } from '@core/routing/ModelUsage';
import type { RoutingPolicyEngine } from '@core/routing/RoutingPolicy';
import type { RoutingSettings } from '@core/routing/RoutingSettings';
import type { SessionStorage } from '@core/storage/SessionStorage';
import type { TraceRecorder } from '@core/trace/TraceRecorder';
import type { VerificationEvent, VerificationOutcome, VerificationTurn, VerificationTurnDecision, VerifyMode } from '@core/verify/VerificationTypes';
import type { AgentRunRequest, ToolEvent } from '../AgentRuntime';

export interface RunRequest {
  sessionId?: string;
  taskId?: string;
  runId?: string;
  assistantMessageId?: string;
  projectId?: string | null;
  prompt: string;
  taskType?: string;
  complexity?: 'low' | 'medium' | 'high';
  stream?: boolean;
  collaboratorModelIds?: string[];
  /** When set, skip routing/orchestration and run this exact model. */
  pinnedModelId?: string;
  contextPaths?: string[];
  includeProjectContext?: boolean;
  contextMaxTokens?: number;
  history?: unknown;
  /** Temporary system rules, excluded from conversation persistence. */
  sessionRules?: string;
  enableTools?: boolean;
  verificationMode?: VerifyMode;
}

export type RunEmit = (channel: string, payload: unknown) => void;

export type InvokeStreamed = (
  model: ModelConfig,
  prompt: string,
  maxTokens: number,
  onDelta: (delta: string) => void,
  options?: {
    history?: ContextTurn[];
    summary?: string;
    skipHistoryTrim?: boolean;
    enableTools?: boolean;
    projectRoot?: string;
    projectAccess?: 'read' | 'write';
    signal?: AbortSignal;
    onToolEvent?: (event: ToolEvent) => void;
    onUsage?: (usage: ModelUsage) => void;
    beforeModelRequest?: (request: ModelRequestEstimate) => { maxOutputTokens: number } | void;
    afterTurn?: AgentRunRequest['afterTurn'];
    sessionRules?: string;
    onRulesLoaded?: AgentRunRequest['onRulesLoaded'];
  },
) => Promise<ModelResponse>;

export interface RunDependencies {
  models: ModelRegistry;
  routing: RoutingPolicyEngine;
  routingSettings?: RoutingSettings;
  onClassification?: (observation: RoutingObservation) => void;
  quota: ModelQuota;
  traces: TraceRecorder;
  observability: ObservabilityEngine;
  growth: GrowthEngine;
  codeAuditor: CodeAuditor;
  auditLog: AuditLog;
  memory: MemoryStore;
  summaries: Pick<SessionStorage, 'getSummary' | 'saveSummary'>;
  projectContext: {
    getRoot(): string | undefined;
    getContextAsync(paths?: string[], maxTokens?: number): Promise<ProjectContextResult | undefined>;
  };
  invokeStreamed: InvokeStreamed;
  controller: AbortController;
  createProvider?: (model: ModelConfig) => ModelProvider;
  createProjectVerification?: (input: {
    projectRoot: string;
    mode: 'quick' | 'full';
    runId: string;
    assertBudget(): void;
    onEvent(event: VerificationEvent): void;
  }) => {
    afterTurn(turn: VerificationTurn, changedFiles: string[], signal?: AbortSignal): Promise<VerificationTurnDecision>;
    resumeAfterReview(feedback: string): VerificationTurnDecision;
    endReview(status: 'failed' | 'unverified' | 'budget_limit' | 'cancelled', summary: string, reason?: string): VerificationTurnDecision;
    readonly outcome: VerificationOutcome | undefined;
  };
}
