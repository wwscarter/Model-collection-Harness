import type { ModelConfig } from '@core/models/ModelConfig';
import type { RunDependencies, RunEmit, RunRequest } from '@core/agent/RunCoordinator';
import type { ApprovalDecision, ApprovalMode, ToolApprovalRequest } from '@core/security/ApprovalPolicy';
import type { VerifyCommand } from '@core/verify/VerificationTypes';
import type { ModelStorage } from '@core/storage/ModelStorage';
import type { SessionStorage } from '@core/storage/SessionStorage';
import type { ProjectStorage } from '@core/storage/ProjectStorage';
import type { ModelRegistry } from '@core/models/ModelRegistry';
import type { GrowthEngine } from '@core/growth/GrowthEngine';
import type { RoutingLearningStore } from '@core/growth/RoutingLearningStore';
import type { RoutingService } from '@core/routing/RoutingService';
import type { AgentRouter } from '@core/routing/AgentRouter';
import type { RoutingPolicyEngine } from '@core/routing/RoutingPolicy';
import type { ProjectManager } from '@core/project/ProjectManager';
import type { ProjectProcessManager } from '@core/tty/ProjectProcessManager';
import type { CommandExecutor } from '@core/tty/CommandExecutor';
import type { CodebaseIndex } from '@core/codebase/CodebaseIndex';
import type { SemanticSearch } from '@core/codebase/SemanticSearch';
import type { CodeSearchConfig } from '@core/codebase/CodeSearchConfig';
import type { SandboxSettings } from '@core/security/SandboxSettings';
import type { TrustStore } from '@core/security/TrustStore';
import type { RulesLoader } from '@core/agent/RulesLoader';
import type { HookStore } from '@core/hooks/HookStore';
import type { SkillManager } from '@core/agent/SkillManager';
import type { McpConfigStore } from '@core/agent/McpConfigStore';
import type { ToolTrustStore } from '@core/security/ToolTrustStore';
import type { AgentRuntime } from '@core/agent/AgentRuntime';
import type { ObservabilityEngine } from '@core/observability/ObservabilityEngine';
import type { ModelQuota } from '@core/routing/ModelQuota';
import type { MemoryStore } from '@core/memory/MemoryStore';
import type { TraceRecorder } from '@core/trace/TraceRecorder';
import type { AuditLog } from '@core/audit/AuditLog';
import type { CodeAuditor } from '@core/audit/CodeAuditor';
import type { PlanController } from '@core/planning/PlanController';
import type { PlanStorage } from '@core/planning/PlanStorage';
import type { RunPlan } from '@core/planning/PlanTypes';
import type { CredentialCodec } from '@utils/crypto';
import type { McpServerEntry } from '@earendil-works/pi-coding-agent';

export type CoreApprovalRequest =
  | ({ kind: 'tool'; decision: ApprovalDecision; signal?: AbortSignal } & ToolApprovalRequest)
  | { kind: 'command'; command: string; cwd: string; projectRoot: string; decision: ApprovalDecision; signal?: AbortSignal }
  | { kind: 'verification'; projectRoot: string; commands: VerifyCommand[]; configPath: string; signal?: AbortSignal }
  | { kind: 'plan'; plan: RunPlan; signal?: AbortSignal };

/** Platform capabilities are injected; importing the core never imports Electron. */
export interface CoreHost {
  dataDir: string;
  confirm(request: CoreApprovalRequest): Promise<boolean> | boolean;
  /** Return a persistent 32-byte key, or its hex/base64 encoding. Never generated implicitly. */
  secretKey?(): Promise<Buffer | string> | Buffer | string;
  /** A synchronous lazy codec lets desktop startup survive an unavailable OS keyring. */
  credentialCodec?: CredentialCodec;
  onMcpStderr?(entry: McpServerEntry, text: string): void;
  emit: RunEmit;
}

export interface CreateCoreOptions {
  approvalMode?: ApprovalMode;
  initializePresets?: boolean;
  /** Explicit models used by callers such as offline evaluations; persisted by default. */
  models?: ModelConfig[];
  persistModels?: boolean;
  enableMcp?: boolean;
  /** Enable only when the host knows no other process is using this data directory. */
  recoverInterruptedRuns?: boolean;
  /** Explicit replay seams; production never falls back to a synthetic answer. */
  invokeStreamed?: RunDependencies['invokeStreamed'];
  createProvider?: RunDependencies['createProvider'];
}

export interface CoreRunOptions {
  projectRoot?: string;
  signal?: AbortSignal;
  /** Optional observer receives the same events as the host. */
  emit?: RunEmit;
}

export interface CoreServices {
  host: CoreHost;
  options: CreateCoreOptions;
  dataDir: string;
  workspaceRoot: string;
  storage: ModelStorage;
  sessionStorage: SessionStorage;
  projectStorage: ProjectStorage;
  registry: ModelRegistry;
  growth: GrowthEngine;
  routingLearning: RoutingLearningStore;
  routingService: RoutingService;
  router: AgentRouter;
  routingPolicy: RoutingPolicyEngine;
  preferencesPath: string;
  preferences: { approvalMode: ApprovalMode };
  routingRulesPath: string;
  routingHistoryDir: string;
  projects: ProjectManager;
  commandExecutor: CommandExecutor;
  projectProcesses: ProjectProcessManager;
  sandboxSettingsPath: string;
  commandSandbox: { settings: SandboxSettings };
  codebase: CodebaseIndex;
  semanticSearch: SemanticSearch;
  codeSearchConfigPath: string;
  codeSearch: { config: CodeSearchConfig };
  trustStore: TrustStore;
  rulesLoader: RulesLoader;
  hookStore: HookStore;
  skillManager: SkillManager;
  mcpConfig: McpConfigStore;
  toolTrust: ToolTrustStore;
  mcpTools: Map<string, string[]>;
  agentRuntime: AgentRuntime;
  observability: ObservabilityEngine;
  modelQuota: ModelQuota;
  memoryStore: MemoryStore;
  traceRecorder: TraceRecorder;
  auditLog: AuditLog;
  codeAuditor: CodeAuditor;
  runningTasks: Map<string, AbortController>;
  planStorage: PlanStorage;
  plans: PlanController;
  emit: RunEmit;
}

export interface Core extends CoreServices {
  run(request: RunRequest, options?: CoreRunOptions): Promise<Record<string, unknown>>;
  createRunDependencies(controller: AbortController, projectContext?: RunDependencies['projectContext']): RunDependencies;
  cancel(runId?: string): void;
  /** Abort active runs, wait for them to finish, then close all stores and processes. */
  dispose(): Promise<void>;
}
