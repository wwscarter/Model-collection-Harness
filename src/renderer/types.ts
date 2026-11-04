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
  maxTokens?: number;
  rateLimit?: { requestsPerMinute: number; tokensPerDay: number };
  costPer1kTokens: { input: number; output: number };
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface SessionMetrics {
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  ttftMs?: number;
  routeConfidence?: number;
  cost?: number;
}

export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled';
export type SpanStatus = RunStatus;
export type SpanKind = 'run' | 'route' | 'context' | 'memory' | 'compact' | 'plan' | 'model' | 'tool' | 'synthesis' | 'audit';

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

export interface ExecutionResult {
  output: string;
  runId?: string;
  modelUsed?: string;
  metrics?: SessionMetrics;
  auditResult?: { passed?: boolean; score?: number; issueCount?: number };
  audit?: { passed: boolean; score: number; issueCount: number; auditModelId?: string };
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
  summary: { totalTasks: number; totalInvocations: number; totalCost: number; successRate: number; avgLatency: number; auditCount?: number; auditPassRate?: number };
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
  routingStatus: () => Promise<{ backend: 'heuristic' | 'local-model'; modelPath?: string; available: boolean }>;
  project: {
    current: () => Promise<ProjectInfo | undefined>;
    select: (root?: string) => Promise<ProjectInfo | undefined>;
    clear: () => Promise<{ success: boolean }>;
    tree: (options?: { path?: string; maxDepth?: number }) => Promise<unknown>;
    context: (options?: { paths?: string[]; maxTokens?: number }) => Promise<unknown>;
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
  executeTask: (input: { sessionId: string; prompt: string; taskType?: string; stream?: boolean; collaboratorModelIds?: string[]; assistantMessageId?: string; contextPaths?: string[]; includeProjectContext?: boolean; contextMaxTokens?: number }) => Promise<ExecutionResult>;
  getTaskMetrics: (sessionId?: string) => Promise<unknown>;
  getRecentInvocations: (limit?: number) => Promise<unknown>;
  getDashboard: (options?: { range?: '24h' | '7d' | '30d' }) => Promise<DashboardSnapshot>;
  getReportMarkdown: (options?: { range?: '24h' | '7d' | '30d' }) => Promise<string>;
  trace: {
    get: (runId: string) => Promise<RunTrace | undefined>;
    recent: (sessionId: string, limit?: number) => Promise<TraceRun[]>;
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
    testConnection: (input: { id?: string; provider: string; baseURL?: string; apiKey?: string; modelId: string; temperature?: number; enableThinking?: boolean; contextWindow?: number }) => Promise<{ success: boolean; latency?: number; error?: string; demo?: boolean }>;
  };
  sessions: {
    list: () => Promise<Array<Record<string, unknown>>>;
    get: (id: string) => Promise<Record<string, unknown> | undefined>;
    save: (session: unknown) => Promise<Record<string, unknown>>;
    delete: (id: string) => Promise<{ success: boolean }>;
    execute: (input: { sessionId: string; prompt: string; taskType?: string; taskId?: string; runId?: string; assistantMessageId?: string; stream?: boolean; collaboratorModelIds?: string[]; contextPaths?: string[]; includeProjectContext?: boolean; contextMaxTokens?: number; history?: Array<{ role: 'user' | 'assistant'; content: string }>; enableTools?: boolean }) => Promise<ExecutionResult>;
    cancel: (taskId: string) => Promise<{ success: boolean }>;
  };
  agent: {
    describe: () => Promise<AgentResourceSummary>;
    searchProviders: () => Promise<Array<{ id: string; label: string; active: boolean }>>;
    setSearchProvider: (id: string) => Promise<Array<{ id: string; label: string; active: boolean }>>;
  };
  on: (channel: 'session:model-switched' | 'session:chunk' | 'session:agent-update' | 'session:tool-call' | 'session:completed' | 'session:trace' | 'tty:data' | 'execution:data', listener: (payload: unknown) => void) => () => void;
}

declare global {
  interface Window {
    amd?: AmdApi;
  }
}

