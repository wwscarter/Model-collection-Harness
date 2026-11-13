import fs from 'node:fs';
import { MediaExecutionService } from '@core/media/MediaExecutionService';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCredentialCodec } from '@utils/crypto';
import { ModelStorage } from '@core/storage/ModelStorage';
import { SessionStorage } from '@core/storage/SessionStorage';
import { FileHistoryStore } from '@core/storage/FileHistoryStore';
import { ProjectStorage } from '@core/storage/ProjectStorage';
import { ModelRegistry } from '@core/models/ModelRegistry';
import { AgentRouter } from '@core/routing/AgentRouter';
import { LocalRoutingModel } from '@core/routing/LocalRoutingModel';
import { RoutingService } from '@core/routing/RoutingService';
import { loadRoutingPolicy, RoutingPolicyEngine } from '@core/routing/RoutingPolicy';
import { ModelQuota } from '@core/routing/ModelQuota';
import { ObservabilityEngine } from '@core/observability/ObservabilityEngine';
import { AuditLog } from '@core/audit/AuditLog';
import { OperationAuditLog } from '@core/audit/OperationAuditLog';
import { RunCheckpointStore } from '@core/storage/RunCheckpointStore';
import { CodeAuditor } from '@core/audit/CodeAuditor';
import { TraceRecorder } from '@core/trace/TraceRecorder';
import { GrowthEngine } from '@core/growth/GrowthEngine';
import { RoutingLearningStore } from '@core/growth/RoutingLearningStore';
import { ProjectManager } from '@core/project/ProjectManager';
import { createRunProjectContext } from '@core/project/RunProjectContext';
import { MemoryStore } from '@core/memory/MemoryStore';
import { createMemoryTools } from '@core/tools/memoryTools';
import { CommandExecutor } from '@core/tty/CommandExecutor';
import { ProjectProcessManager } from '@core/tty/ProjectProcessManager';
import { createProjectCommandTools } from '@core/tools/projectCommandTools';
import { AgentRuntime } from '@core/agent/AgentRuntime';
import { executeRun, type RunRequest } from '@core/agent/RunCoordinator';
import { RulesLoader } from '@core/agent/RulesLoader';
import { HookStore } from '@core/hooks/HookStore';
import { SkillManager } from '@core/agent/SkillManager';
import { McpConfigStore } from '@core/agent/McpConfigStore';
import { createConfiguredMcpTransport } from '@core/agent/McpTransport';
import { ToolTrustStore } from '@core/security/ToolTrustStore';
import { TrustStore } from '@core/security/TrustStore';
import { evaluateCommandApproval, loadApprovalMode } from '@core/security/ApprovalPolicy';
import { CodebaseIndex } from '@core/codebase/CodebaseIndex';
import { SemanticSearch } from '@core/codebase/SemanticSearch';
import { loadCodeSearchConfig } from '@core/codebase/CodeSearchConfig';
import { createCodebaseTools } from '@core/tools/codebaseTools';
import { createSandboxPolicy } from '@core/security/Sandbox';
import { loadSandboxSettings } from '@core/security/SandboxSettings';
import { PlanStorage } from '@core/planning/PlanStorage';
import { PlanController } from '@core/planning/PlanController';
import type { RunPlan } from '@core/planning/PlanTypes';
import { approveCoreTool } from './approval';
import { createCoreRunDependencies } from './runDependencies';
import type { Core, CoreHost, CoreRunOptions, CoreServices, CreateCoreOptions } from './CoreTypes';

export type { Core, CoreApprovalRequest, CoreHost, CoreRunOptions, CreateCoreOptions } from './CoreTypes';

/** Assemble the same runtime used by the desktop with explicit host capabilities. */
export async function createCore(host: CoreHost, options: CreateCoreOptions = {}): Promise<Core> {
  if (!host.dataDir?.trim()) throw new Error('Core dataDir is required');
  if (typeof host.confirm !== 'function' || typeof host.emit !== 'function') throw new Error('Core confirm and emit callbacks are required');
  const cleanupTasks: Array<() => void> = [];
  const track = <T>(resource: T, cleanup: (resource: T) => void): T => { cleanupTasks.push(() => cleanup(resource)); return resource; };
  try {
    fs.mkdirSync(path.resolve(host.dataDir), { recursive: true, mode: 0o700 });
    const dataDir = fs.realpathSync(path.resolve(host.dataDir));
    const workspaceRoot = path.join(dataDir, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const suppliedKey = !host.credentialCodec && host.secretKey ? await host.secretKey() : process.env.AMD_ENCRYPTION_KEY;
    const codec = host.credentialCodec ?? createCredentialCodec(() => {
      if (!suppliedKey) throw new Error('No persistent encryption key configured. Set AMD_ENCRYPTION_KEY or provide CoreHost.secretKey.');
      return suppliedKey;
    });
    const storage = track(new ModelStorage(path.join(dataDir, 'amd.db'), codec), (value) => value.close());
    const sessionStorage = track(new SessionStorage(path.join(dataDir, 'sessions.db')), (value) => value.close());
    const fileHistory = track(new FileHistoryStore(path.join(dataDir, 'file-history.db')), (value) => value.close());
    const operationAudit = track(new OperationAuditLog(path.join(dataDir, 'operations.jsonl')), (value) => value.close());
    const checkpoints = track(new RunCheckpointStore(path.join(dataDir, 'checkpoints.db')), (value) => value.close());
    const planStorage = track(new PlanStorage(path.join(dataDir, 'sessions.db')), (value) => value.close());
    const plans = new PlanController(planStorage);
    const projectStorage = track(new ProjectStorage(path.join(dataDir, 'projects.db')), (value) => value.close());
    const registry = new ModelRegistry(storage, { initializePresets: options.initializePresets ?? true, persist: options.persistModels ?? true });
    for (const model of options.models ?? []) registry.registerModel(model, { persist: options.persistModels ?? true });
    const growth = new GrowthEngine({ storagePath: path.join(dataDir, 'growth-profiles.json') });
    const routingLearning = new RoutingLearningStore(path.join(dataDir, 'routing-corrections.json'));
    const routingService = track(new RoutingService(path.join(dataDir, 'routing-settings.json'), { getExamples: (context) => routingLearning.getExamples(context) }), (value) => value.dispose());
    const router = new AgentRouter(registry, growth, new LocalRoutingModel({ classifier: routingService }));
    const preferencesPath = path.join(dataDir, 'preferences.json');
    const preferences = { approvalMode: options.approvalMode ?? loadApprovalMode(preferencesPath) };
    const routingRulesPath = path.join(dataDir, 'routing-rules.json');
    const routingHistoryDir = path.join(dataDir, 'routing-rules.history');
    fs.mkdirSync(routingHistoryDir, { recursive: true });
    const policy = loadRoutingPolicy(routingRulesPath);
    const routingPolicy = new RoutingPolicyEngine(router, policy.policy);
    for (const diagnostic of policy.diagnostics) console.warn('[routing]', diagnostic);
    const projects = new ProjectManager();
    const sandboxSettingsPath = path.join(dataDir, 'sandbox-settings.json');
    const commandSandbox = { settings: loadSandboxSettings(sandboxSettingsPath) };
    const sandboxPolicy = (root: string) => createSandboxPolicy(root, commandSandbox.settings);
    const commandExecutor = track(new CommandExecutor({ sandboxPolicy }), (value) => value.dispose());
    const projectProcesses = track(new ProjectProcessManager({ sandboxPolicy, onAudit: (event) => operationAudit.append({
      type: 'command.execute', actor: 'agent', result: event.status === 'failed' ? 'failed' : event.status === 'stopped' ? 'stopped' : 'success',
      ...(event.sessionId ? { sessionId: event.sessionId } : {}), command: event.command, ...(event.exitCode === null ? {} : { detail: `退出码 ${event.exitCode}` }),
    }) }), (value) => value.dispose());
    const codebase = track(new CodebaseIndex(dataDir), (value) => value.dispose());
    const codeSearchConfigPath = path.join(dataDir, 'code-search.json');
    const codeSearch = { config: loadCodeSearchConfig(codeSearchConfigPath) };
    const semanticSearch = track(new SemanticSearch({ dataDir, getConfig: () => codeSearch.config, getBaseURL: () => routingService.getConfiguration().settings.classifier.baseURL }), (value) => value.close());
    const agentDir = path.join(dataDir, 'agent');
    const trustStore = new TrustStore(path.join(dataDir, 'trust.json'));
    const rulesLoader = new RulesLoader({ agentDir, trustStore });
    const hookStore = new HookStore(agentDir, trustStore);
    const skillManager = new SkillManager(agentDir);
    const mcpConfig = new McpConfigStore(agentDir, codec);
    const toolTrust = new ToolTrustStore(path.join(agentDir, 'tool-trust.json'));
    const memoryStore = track(new MemoryStore(path.join(dataDir, 'memory.db')), (value) => value.close());
    let ctx: CoreServices;
    const agentRuntime = new AgentRuntime({
      agentDir, defaultCwd: workspaceRoot, skillManager, mcpConfig, enableMcp: options.enableMcp !== false, fileHistory, operationAudit,
      mcpTransport: (entry, cwd, authProvider) => createConfiguredMcpTransport({ entry, cwd, authProvider, sandboxPolicy, onStderr: (text) => host.onMcpStderr?.(entry, text) }).transport,
      toolGate: (request) => approveCoreTool(ctx, request),
      extraTools: ({ projectRoot, sessionId, trackCommandChanges }) => [
        ...(projectRoot ? createProjectCommandTools(projectRoot, projectProcesses, { commandPolicy: (command) => evaluateCommandApproval(preferences.approvalMode, command, projectRoot), sessionId, trackChanges: trackCommandChanges }) : []),
        ...(projectRoot ? createCodebaseTools(projectRoot, codebase, semanticSearch, codeSearch.config.enabled, { config: structuredClone(codeSearch.config), baseURL: routingService.getConfiguration().settings.classifier.baseURL }) : []),
        ...createMemoryTools(memoryStore, { projectRoot }),
      ],
    });
    const observability = track(new ObservabilityEngine(path.join(dataDir, 'metrics.db')), (value) => value.close());
    if (options.recoverInterruptedRuns) observability.recoverInterruptedRuns();
    const modelQuota = new ModelQuota(observability);
    const traceRecorder = new TraceRecorder(observability, { onEvent: (event) => {
      host.emit('session:trace', event);
      if (event.type === 'run_end') { try { observability.pruneTraces(observability.getTraceRetention()); } catch (error) { console.warn('Trace retention failed', error); } }
    } });
    const auditLog = new AuditLog(path.join(dataDir, 'audit.jsonl'));
    const codeAuditor = new CodeAuditor();
    const media = new MediaExecutionService({ dataDir, models: registry });
    ctx = { media, host, options, dataDir, workspaceRoot, storage, sessionStorage, fileHistory, operationAudit, checkpoints, projectStorage, registry, growth, routingLearning, routingService, router, routingPolicy, preferencesPath, preferences, routingRulesPath, routingHistoryDir, projects, commandExecutor, projectProcesses, sandboxSettingsPath, commandSandbox, codebase, semanticSearch, codeSearchConfigPath, codeSearch, trustStore, rulesLoader, hookStore, skillManager, mcpConfig, toolTrust, mcpTools: new Map(), agentRuntime, observability, modelQuota, memoryStore, traceRecorder, auditLog, codeAuditor, planStorage, plans, runningTasks: new Map(), emit: host.emit };
    let closing = false;
    let disposal: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    const core: Core = Object.assign(ctx, {
      createRunDependencies: (controller, projectContext) => createCoreRunDependencies(ctx, controller, projectContext),
      async run(request: RunRequest, runOptions: CoreRunOptions = {}) {
        if (closing) throw new Error('Core is disposed');
        runOptions.signal?.throwIfAborted();
        const normalized = { ...request, runId: request.runId ?? randomUUID(), sessionId: request.sessionId ?? randomUUID() };
        if (ctx.runningTasks.has(normalized.runId)) throw new Error('Run is already active: ' + normalized.runId);
        const controller = new AbortController();
        const abort = () => controller.abort(runOptions.signal?.reason);
        const projectContext = runOptions.projectRoot ? new ProjectManager() : createRunProjectContext(request.projectId, projectStorage);
        if (runOptions.projectRoot) projectContext.select(runOptions.projectRoot);
        runOptions.signal?.addEventListener('abort', abort, { once: true });
        const emit = (channel: string, payload: unknown) => {
          host.emit(channel, payload); runOptions.emit?.(channel, payload);
          if (channel === 'session:plan' && (payload as RunPlan).status === 'awaiting') {
            const plan = payload as RunPlan;
            void Promise.resolve().then(() => host.confirm({ kind: 'plan', plan, signal: controller.signal })).then((approved) => {
              if (controller.signal.aborted) return;
              const latest = plans.latest(plan.runId);
              if (latest?.version === plan.version && latest.status === 'awaiting') plans.decide({ runId: plan.runId, version: plan.version, action: approved ? 'approve' : 'cancel' });
            }).catch((error) => controller.abort(error));
          }
        };
        ctx.runningTasks.set(normalized.runId, controller);
        const operation = executeRun(normalized, createCoreRunDependencies(ctx, controller, projectContext), emit);
        pending.add(operation);
        try { return await operation; }
        finally { pending.delete(operation); ctx.runningTasks.delete(normalized.runId); runOptions.signal?.removeEventListener('abort', abort); }
      },
      cancel(runId?: string) {
        if (runId) ctx.runningTasks.get(runId)?.abort();
        else for (const controller of ctx.runningTasks.values()) controller.abort();
      },
      dispose() {
        if (disposal) return disposal;
        closing = true;
        core.cancel();
        const stoppedProcesses = projectProcesses.list().filter((process) => process.running).map((process) => projectProcesses.stop(process.id));
        projectProcesses.dispose();
        commandExecutor.dispose();
        disposal = (async () => {
          await Promise.allSettled([...pending, ...stoppedProcesses]);
          for (const cleanup of cleanupTasks.reverse()) { try { cleanup(); } catch (error) { console.warn('Core cleanup failed', error); } }
        })();
        return disposal;
      },
    } satisfies Pick<Core, 'run' | 'createRunDependencies' | 'cancel' | 'dispose'>);
    return core;
  } catch (error) {
    for (const cleanup of cleanupTasks.reverse()) { try { cleanup(); } catch { /* preserve startup failure */ } }
    throw error;
  }
}
