import type { RoutingSettings } from '@core/routing/RoutingSettings';
import type { RoutingClassifierStatus } from '@core/routing/LocalRoutingModel';
import type { RoutingCorrection, RoutingObservation } from '@core/growth/RoutingLearningStore';
import type { CodebaseApi } from './codebaseTypes';
import type { SandboxApi } from './sandboxTypes';
import type { VerificationMode } from './verificationTypes';
import type { RulesApi } from './rulesTypes';
import type { HooksApi } from './hooksTypes';
import type { SkillsApi } from './skillsTypes';
import type { McpApi } from './mcpTypes';
import type { ToolTrustApi } from './toolTrustTypes';
import type { PlanDecision, PlanningMode, RunPlan } from '@core/planning/PlanTypes';
import type { ModelOperations } from '@core/models/ModelOperations';
import type { MediaArtifact } from './mediaTypes';

export interface ModelCapability { type: string; score: number; }

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  baseURL?: string;
  modelId: string;
  providerCategory?: 'official' | 'compatible_gateway' | 'custom_proxy' | 'local_ollama';
  availableModels?: string[];
  temperature?: number;
  enableThinking?: boolean;
  isPrimary?: boolean;
  contextWindow?: number;
  intelligenceScore?: number;
  apiKey?: string;
  hasApiKey?: boolean;
  credentialError?: string;
  enabled: boolean;
  priority: number;
  capabilities: ModelCapability[];
  operations?: ModelOperations;
  maxTokens?: number;
  rateLimit?: { requestsPerMinute: number; tokensPerDay: number };
  costPer1kTokens: { input: number; output: number };
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface SessionMetrics {
  /** Why the model stopped; resource limits can leave a usable partial answer. */
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  ttftMs?: number;
  routeConfidence?: number;
  cost?: number;
  budgetLimit?: BudgetLimitNotice;
}

export interface BudgetLimitNotice { code: 'BUDGET_EXCEEDED'; message: string; estimatedCost: number; maxCostUsd: number; }

export interface TraceModelSnapshot {
  configurationId: string;
  modelId: string;
  name: string;
  provider: string;
  endpointOrigin?: string;
  costPer1kTokens: { input: number; output: number };
  configurationUpdatedAt: string;
  pricingBasis?: 'configured-token-rates';
  legacyPresetRates?: boolean;
}

export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled';
export type SpanStatus = RunStatus;
export type SpanKind = 'run' | 'route' | 'context' | 'memory' | 'compact' | 'plan' | 'model' | 'tool' | 'synthesis' | 'audit' | 'verify' | 'verify-command' | 'verify-repair' | 'hook';

export interface TraceRun {
  id: string;
  sessionId: string;
  taskType?: string;
  complexity?: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  errorMessage?: string;
}

export interface TraceSpan {
  id: string;
  runId: string;
  parentSpanId?: string;
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  attributes?: Record<string, unknown>;
  errorMessage?: string;
}

export interface RunTrace { run: TraceRun; spans: TraceSpan[]; }

export type MemoryScope = 'global' | 'project' | 'session';
export type MemoryKind = 'preference' | 'fact' | 'decision' | 'todo' | 'artifact';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  projectRoot?: string;
  sessionId?: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  source: 'user' | 'agent' | 'tool';
  confidence: number;
  status: 'active' | 'pending';
  createdAt: string | Date;
  updatedAt: string | Date;
  lastUsedAt?: string | Date;
  expiresAt?: string | Date;
}

export interface ExecutionResult {
  output: string;
  artifacts?: MediaArtifact[];
  stopReason?: string;
  runId?: string;
  modelUsed?: string;
  metrics?: SessionMetrics;
  budgetLimit?: BudgetLimitNotice;
  auditResult?: { passed?: boolean; score?: number; issueCount?: number };
  audit?: { passed: boolean; score: number; issueCount: number; auditModelId?: string };
  verification?: { modelId: string; approved: boolean; score: number; issueCount: number; revised: boolean; auditModelId?: string };
  project?: { root: string; files: string[]; tokenCount: number; truncated: boolean; skippedFiles: number };
}

export interface CommandExecutionResult {
  id: string;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
}


export interface DashboardSnapshot {
  range: { from: string; to: string };
  summary: { totalTasks: number; totalInvocations: number; totalCost: number; successRate: number; avgLatency: number; auditCount?: number; auditPassRate?: number; verificationCount?: number; verificationPassRate?: number; verificationUnverified?: number };
  modelUsage: Array<{ modelId: string; invocations: number; totalCost: number; successRate: number; share?: number }>;
  costTrend: Array<{ bucket: string; totalCost: number; invocations: number; totalTokens: number }>;
  recent: Array<{ id: string; taskId: string; modelId: string; startTime: string | Date; inputTokens: number; outputTokens: number; totalCost: number; status: string; latency?: number }>;
}

export interface GitInfo { branch?: string; detached?: boolean; head?: string; }

/** The open project as described by the main process (no file contents). */
export interface ProjectInfo {
  id?: string;
  name: string;
  root: string;
  displayRoot: string;
  git?: GitInfo;
  languages: string[];
  markers: string[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  root: string;
  displayRoot: string;
  active: boolean;
  lastOpenedAt: string | Date;
  createdAt: string | Date;
}

/** What the agent runtime can use: skills, tools and search backends. */
export interface AgentResourceSummary {
  agentDir: string;
  skills: Array<{ name: string; description: string; path: string }>;
  tools: string[];
  searchProviders: Array<{ id: string; label: string; active: boolean }>;
  diagnostics: string[];
}

export interface AmdApi {
  sandbox: SandboxApi;
  codebase: CodebaseApi;
  routingStatus: () => Promise<RoutingClassifierStatus>;
  routingConfig: {
    get: () => Promise<{ settings: RoutingSettings; status: RoutingClassifierStatus }>;
    set: (settings: RoutingSettings) => Promise<{ settings: RoutingSettings; status: RoutingClassifierStatus }>;
    probe: (settings?: RoutingSettings) => Promise<{ status: RoutingClassifierStatus; models: string[] }>;
  };
  routingLearning: {
    get: (runId: string) => Promise<{ observation?: RoutingObservation; correction?: RoutingCorrection } | undefined>;
    correct: (input: { runId: string; taskType: RoutingCorrection['expected']['taskType']; complexity: RoutingCorrection['expected']['complexity'] }) => Promise<RoutingCorrection>;
    export: () => Promise<{ version: 1; source: 'user-corrections'; samples: RoutingCorrection[] }>;
    clear: () => Promise<{ success: boolean }>;
  };
  project: {
    current: () => Promise<ProjectInfo | undefined>;
    select: (root?: string) => Promise<ProjectInfo | undefined>;
    clear: () => Promise<{ success: boolean }>;
    tree: (options?: { path?: string; maxDepth?: number }) => Promise<unknown>;
    context: (options?: { paths?: string[]; maxTokens?: number }) => Promise<unknown>;
    file: (path: string) => Promise<{ content: string; truncated: boolean; size: number }>;
    initGit: () => Promise<ProjectInfo>;
  };
  projects: {
    list: () => Promise<ProjectRecord[]>;
    open: (id: string) => Promise<ProjectInfo>;
    remove: (id: string) => Promise<{ success: boolean }>;
    pickDirectory: () => Promise<(ProjectInfo & { existing: boolean }) | undefined>;
    create: (input: { root: string; name: string }) => Promise<ProjectInfo>;
  };
  listModels: () => Promise<ModelConfig[]>;
  registerModel: (config: unknown) => Promise<{ success: boolean; model: ModelConfig }>;
  updateModel: (id: string, updates: unknown) => Promise<{ success: boolean; model: ModelConfig }>;
  deleteModel: (id: string) => Promise<{ success: boolean }>;
  testModel: (id: string) => Promise<unknown>;
  executeTask: (input: { sessionId: string; prompt: string; taskType?: string; stream?: boolean; collaboratorModelIds?: string[]; assistantMessageId?: string; verificationMode?: VerificationMode; planningMode?: PlanningMode; sessionRules?: string; contextPaths?: string[]; includeProjectContext?: boolean; contextMaxTokens?: number }) => Promise<ExecutionResult>;
  getTaskMetrics: (sessionId?: string) => Promise<unknown>;
  getRecentInvocations: (limit?: number) => Promise<unknown>;
  getDashboard: (options?: { range?: '24h' | '7d' | '30d' }) => Promise<DashboardSnapshot>;
  getReportMarkdown: (options?: { range?: '24h' | '7d' | '30d' }) => Promise<string>;
  trace: {
    get: (runId: string) => Promise<RunTrace | undefined>;
    recent: (sessionId: string, limit?: number) => Promise<TraceRun[]>;
    list: (limit?: number) => Promise<TraceRun[]>;
    settings: () => Promise<{ maxAgeDays: number; maxRuns: number }>;
    setSettings: (options: { maxAgeDays?: number; maxRuns?: number }) => Promise<{ maxAgeDays: number; maxRuns: number }>;
    clear: () => Promise<{ runs: number; spans: number }>;
  };
  preferences: {
    get: () => Promise<{ approvalMode: 'ask' | 'auto' | 'full' }>;
    set: (input: { approvalMode: 'ask' | 'auto' | 'full' }) => Promise<{ approvalMode: 'ask' | 'auto' | 'full' }>;
  };
  routingRules: {
    get: () => Promise<{ path: string; text: string }>;
    set: (text: string) => Promise<{ policy: unknown; diagnostics: string[] }>;
    history: () => Promise<Array<{ name: string; savedAt: string }>>;
    restore: (name: string) => Promise<{ text: string; policy: unknown; diagnostics: string[] }>;
  };
  memory: {
    list: (options?: { scope?: MemoryScope }) => Promise<MemoryRecord[]>;
    add: (input: { content: string; kind?: MemoryKind; scope?: MemoryScope; tags?: string[] }) => Promise<MemoryRecord>;
    remove: (id: string) => Promise<{ success: boolean }>;
    approve: (id: string) => Promise<{ success: boolean }>;
    approveMany: (ids: string[]) => Promise<{ count: number }>;
    removeMany: (ids: string[]) => Promise<{ count: number }>;
    exportAll: () => Promise<MemoryRecord[]>;
    clear: () => Promise<{ removed: number }>;
    settings: () => Promise<{ autoExtract: boolean }>;
    setAutoExtract: (enabled: boolean) => Promise<{ autoExtract: boolean }>;
  };
  verifyAuditLog: () => Promise<{ valid: boolean; entries: number; error?: string }>;
  getGrowthProfiles: () => Promise<unknown[]>;
  recordGrowthFeedback: (feedback: unknown) => Promise<unknown>;
  tty: { list: () => Promise<unknown[]>; create: (options?: unknown) => Promise<unknown>; write: (id: string, data: string) => Promise<void>; resize: (id: string, cols: number, rows: number) => Promise<void>; close: (id: string) => Promise<boolean>; };
  execution: {
    run: (request: { command: string; cwd?: string; timeoutMs?: number; maxOutputBytes?: number }) => Promise<CommandExecutionResult>;
    cancel: (id: string) => Promise<boolean>;
  };
  off?: (channel: string, listener: (payload: unknown) => void) => void;
  models: {
    list: () => Promise<ModelConfig[]>;
    register: (config: Omit<ModelConfig, 'id'>) => Promise<{ success: boolean; model: ModelConfig }>;
    update: (id: string, updates: Partial<ModelConfig>) => Promise<{ success: boolean; model: ModelConfig }>;
    delete: (id: string) => Promise<{ success: boolean }>;
    setPrimary: (id: string) => Promise<ModelConfig[]>;
    fetchModels: (input: { id?: string; provider: string; baseURL?: string; apiKey?: string }) => Promise<{ models: string[] }>;
    testConnection: (input: { id?: string; provider: string; baseURL?: string; apiKey?: string; modelId: string; temperature?: number; enableThinking?: boolean; contextWindow?: number; operations?: ModelOperations }) => Promise<{ success: boolean; latency?: number; error?: string; demo?: boolean }>;
  };
  media: {
    open: (assetId: string) => Promise<void>;
    export: (assetId: string) => Promise<{ cancelled: boolean; path?: string }>;
  };
  sessions: {
    plans?: (sessionId: string) => Promise<RunPlan[]>;
    planDecision?: (decision: PlanDecision) => Promise<RunPlan>;
    list: () => Promise<Array<Record<string, unknown>>>;
    get: (id: string) => Promise<Record<string, unknown> | undefined>;
    save: (session: unknown) => Promise<Record<string, unknown>>;
    delete: (id: string) => Promise<{ success: boolean }>;
    execute: (input: { sessionId: string; projectId?: string | null; prompt: string; taskType?: string; taskId?: string; runId?: string; assistantMessageId?: string; stream?: boolean; collaboratorModelIds?: string[]; pinnedModelId?: string; textModelPreferenceId?: string; operation?: 'auto' | 'text.chat' | 'image.generate' | 'video.generate'; verificationMode?: VerificationMode; planningMode?: PlanningMode; sessionRules?: string; contextPaths?: string[]; includeProjectContext?: boolean; contextMaxTokens?: number; history?: Array<{ role: 'user' | 'assistant'; content: string; tools?: Array<{ name: string; status?: string; label?: string; summary?: string }> }>; enableTools?: boolean }) => Promise<ExecutionResult>;
    cancel: (taskId: string) => Promise<{ success: boolean }>;
  };
  agent: {
    skills: SkillsApi;
    mcp: McpApi;
    toolTrust: ToolTrustApi;
    hooks: HooksApi;
    rules: RulesApi;
    describe: () => Promise<AgentResourceSummary>;
    searchProviders: () => Promise<Array<{ id: string; label: string; active: boolean }>>;
    setSearchProvider: (id: string) => Promise<Array<{ id: string; label: string; active: boolean }>>;
  };
  on: (channel: 'session:model-switched' | 'session:chunk' | 'session:agent-update' | 'session:tool-call' | 'session:completed' | 'session:media-job' | 'session:media-artifact' | 'session:verification' | 'session:plan' | 'session:trace' | 'tty:data' | 'execution:data', listener: (payload: unknown) => void) => () => void;
}

declare global {
  interface Window {
    amd?: AmdApi;
  }
}

