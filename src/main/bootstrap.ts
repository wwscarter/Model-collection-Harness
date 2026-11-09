import { app, dialog, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { configureEncryptionKeyProvider, createElectronSafeStorageKeyProvider } from '@utils/crypto';
import { ModelStorage } from '@core/storage/ModelStorage';
import { SessionStorage } from '@core/storage/SessionStorage';
import { ProjectStorage } from '@core/storage/ProjectStorage';
import { ModelRegistry } from '@core/models/ModelRegistry';
import { hasUsableCredentials } from '@core/models/ModelConfig';
import { AgentRouter } from '@core/routing/AgentRouter';
import { LocalRoutingModel } from '@core/routing/LocalRoutingModel';
import { RoutingService } from '@core/routing/RoutingService';
import { loadRoutingPolicy, RoutingPolicyEngine } from '@core/routing/RoutingPolicy';
import { ModelQuota } from '@core/routing/ModelQuota';
import { ObservabilityEngine } from '@core/observability/ObservabilityEngine';
import { AuditLog } from '@core/audit/AuditLog';
import { CodeAuditor } from '@core/audit/CodeAuditor';
import { TraceRecorder } from '@core/trace/TraceRecorder';
import { GrowthEngine } from '@core/growth/GrowthEngine';
import { RoutingLearningStore } from '@core/growth/RoutingLearningStore';
import { TtyManager } from '@core/tty/TtyManager';
import { ProjectManager } from '@core/project/ProjectManager';
import { MemoryStore } from '@core/memory/MemoryStore';
import { createMemoryTools } from '@core/tools/memoryTools';
import { CommandExecutor } from '@core/tty/CommandExecutor';
import { ProjectProcessManager } from '@core/tty/ProjectProcessManager';
import { createProjectCommandTools } from '@core/tools/projectCommandTools';
import { AgentRuntime } from '@core/agent/AgentRuntime';
import { loadApprovalMode } from '@core/security/ApprovalPolicy';
import { CodebaseIndex } from '@core/codebase/CodebaseIndex';
import { SemanticSearch } from '@core/codebase/SemanticSearch';
import { loadCodeSearchConfig } from '@core/codebase/CodeSearchConfig';
import { createCodebaseTools } from '@core/tools/codebaseTools';
import { createSandboxPolicy } from '@core/security/Sandbox';
import { loadSandboxSettings } from '@core/security/SandboxSettings';
import { evaluateCommandApproval } from '@core/security/ApprovalPolicy';
import { approveToolCall } from './approvalPrompt';
import type { MainContext } from './MainContext';

/** Electron supplies its data directory and window; all long-lived state is returned. */
export function createMainContext(dataDir: string, getWindow: MainContext['getWindow']): MainContext {
  const cleanupTasks: (() => void)[] = [];
  const track = <T>(resource: T, cleanup: (resource: T) => void): T => {
    cleanupTasks.push(() => cleanup(resource));
    return resource;
  };
  try {
    const emit: MainContext['emit'] = (channel, payload) => getWindow()?.webContents.send(channel, payload);
    const workspaceRoot = path.join(dataDir, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const keyPath = path.join(dataDir, 'credentials.key');
    // An explicit environment key is the documented recovery path when the OS
    // keyring is unavailable or credentials.key was lost.
    if (process.env.AMD_ENCRYPTION_KEY) configureEncryptionKeyProvider(() => process.env.AMD_ENCRYPTION_KEY!);
    else configureEncryptionKeyProvider(createElectronSafeStorageKeyProvider({ keyPath, safeStorage }));
    const storage = track(new ModelStorage(path.join(dataDir, 'amd.db')), (resource) => resource.close());
    const sessionStorage = track(new SessionStorage(path.join(dataDir, 'sessions.db')), (resource) => resource.close());
    const projectStorage = track(new ProjectStorage(path.join(dataDir, 'projects.db')), (resource) => resource.close());
    const registry = new ModelRegistry(storage, { initializePresets: true, persist: true });
    // Never enable a preset that cannot make a real request. A fresh install has no
    // credentials, and silently selecting GPT-4 used to produce demo answers.
    if (!registry.getEnabledModels().some(hasUsableCredentials)) {
      const usable = registry.getAllModels().find(hasUsableCredentials);
      if (usable) registry.updateModel(usable.id, { enabled: true });
    }
    const growth = new GrowthEngine({ storagePath: path.join(dataDir, 'growth-profiles.json') });
    const routingLearning = new RoutingLearningStore(path.join(dataDir, 'routing-corrections.json'));
    const routingService = track(new RoutingService(path.join(dataDir, 'routing-settings.json'), { getExamples: (context) => routingLearning.getExamples(context) }), (resource) => resource.dispose());
    const router = new AgentRouter(registry, growth, new LocalRoutingModel({ classifier: routingService }));
    const preferencesPath = path.join(dataDir, 'preferences.json');
    const preferences = { approvalMode: loadApprovalMode(preferencesPath) };
    const routingRulesPath = path.join(dataDir, 'routing-rules.json');
    const routingHistoryDir = path.join(dataDir, 'routing-rules.history');
    fs.mkdirSync(routingHistoryDir, { recursive: true });
    const routingPolicyState = loadRoutingPolicy(routingRulesPath);
    const routingPolicy = new RoutingPolicyEngine(router, routingPolicyState.policy);
    for (const diagnostic of routingPolicyState.diagnostics) console.warn('[routing]', diagnostic);
    const tty = track(new TtyManager({ defaultCwd: workspaceRoot }), (resource) => resource.dispose());
    const projects = new ProjectManager();
    const sandboxSettingsPath = path.join(dataDir, 'sandbox-settings.json');
    const commandSandbox = { settings: loadSandboxSettings(sandboxSettingsPath) };
    const sandboxPolicy = (root: string) => createSandboxPolicy(root, commandSandbox.settings);
    const commandExecutor = track(new CommandExecutor({ sandboxPolicy }), (resource) => resource.dispose());
    const projectProcesses = track(new ProjectProcessManager({ sandboxPolicy }), (resource) => resource.dispose());
    const codebase = track(new CodebaseIndex(dataDir), (resource) => resource.dispose());
    const codeSearchConfigPath = path.join(dataDir, 'code-search.json');
    const codeSearch = { config: loadCodeSearchConfig(codeSearchConfigPath) };
    const semanticSearch = track(new SemanticSearch({
      dataDir, getConfig: () => codeSearch.config,
      getBaseURL: () => routingService.getConfiguration().settings.classifier.baseURL,
    }), (resource) => resource.close());
    // Pi resources (skills/, extensions/, mcp.json) live in newAi's own data folder, never ~/.pi.
    // No project selected means an empty app-owned workspace, not ~/Documents.
    const agentRuntime = new AgentRuntime({
      agentDir: path.join(dataDir, 'agent'), defaultCwd: workspaceRoot,
      toolGate: (request) => approveToolCall(ctx, request), enableMcp: true,
      extraTools: ({ projectRoot }) => [
        ...(projectRoot ? createProjectCommandTools(projectRoot, projectProcesses, { commandPolicy: (command) => evaluateCommandApproval(preferences.approvalMode, command, projectRoot) }) : []),
        ...(projectRoot ? createCodebaseTools(projectRoot, codebase, semanticSearch, codeSearch.config.enabled, { config: structuredClone(codeSearch.config), baseURL: routingService.getConfiguration().settings.classifier.baseURL }) : []),
        ...createMemoryTools(memoryStore, { projectRoot }),
      ],
    });
    const observability = track(new ObservabilityEngine(path.join(dataDir, 'metrics.db')), (resource) => resource.close());
    observability.recoverInterruptedRuns();
    const modelQuota = new ModelQuota(observability);
    const memoryStore = track(new MemoryStore(path.join(dataDir, 'memory.db')), (resource) => resource.close());
    const traceRecorder = new TraceRecorder(observability, {
      onEvent: (event) => {
        emit('session:trace', event);
        if (event.type === 'run_end') {
          try { observability.pruneTraces(observability.getTraceRetention()); }
          catch (error) { console.warn('Trace retention failed', error); }
        }
      },
    });
    try { observability.pruneTraces(observability.getTraceRetention()); } catch (error) { console.warn('Trace retention failed', error); }
    const auditLog = new AuditLog(path.join(dataDir, 'audit.jsonl'));
    const codeAuditor = new CodeAuditor();
    const ctx: MainContext = {
      getWindow, emit, workspaceRoot, storage, sessionStorage, projectStorage, registry,
      growth, routingLearning, routingService, router, preferencesPath, preferences,
      routingRulesPath, routingHistoryDir, routingPolicy, tty, projects, commandExecutor,
      projectProcesses, agentRuntime, observability, modelQuota, memoryStore, traceRecorder,
      auditLog, codeAuditor, ttyUnsubscribers: new Map(), commandUnsubscribers: new Map(),
      runningTasks: new Map(), pickedProjectRoots: new Set(),
      codebase, semanticSearch, codeSearchConfigPath, codeSearch,
      sandboxSettingsPath, commandSandbox,
    };
    return ctx;
  } catch (error) {
    // Preserve cleanup when startup fails before the complete context is returned.
    for (const cleanup of cleanupTasks.reverse()) {
      try { cleanup(); } catch { /* preserve the startup error */ }
    }
    throw error;
  }
}

export function disposeMainContext(ctx: MainContext): void {
  for (const controller of ctx.runningTasks.values()) controller.abort();
  ctx.routingService.dispose();
  ctx.tty.dispose();
  ctx.commandExecutor.dispose();
  ctx.projectProcesses.dispose();
  ctx.codebase.dispose();
  ctx.semanticSearch.close();
  ctx.storage.close();
  ctx.sessionStorage.close();
  ctx.projectStorage.close();
  ctx.observability.close();
  ctx.memoryStore.close();
}

export function showCredentialWarning(ctx: MainContext): void {
  if (process.env.AMD_ENCRYPTION_KEY || safeStorage.isEncryptionAvailable()) return;
  const options = {
    type: 'warning' as const,
    title: '系统密钥库不可用',
    message: '无法使用系统密钥库加密 API Key',
    detail: '应用仍可启动，但已保存的凭据无法解密，新凭据也无法保存。请检查系统钥匙串，或设置 AMD_ENCRYPTION_KEY 后重新启动。损坏的模型会显示“需重新输入”。',
    buttons: ['知道了'],
  };
  const mainWindow = ctx.getWindow();
  if (mainWindow) void dialog.showMessageBox(mainWindow, options); else void dialog.showMessageBox(options);
}

/** Keep the failure visible and recoverable instead of quitting with only a console line. */
export function reportStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'startup-error.log'), `${new Date().toISOString()}\n${error instanceof Error ? error.stack ?? message : message}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* best effort */ }
  console.error('AMD Agent failed to start', error);
  try { dialog.showErrorBox('newAi 启动失败', `${message}\n\n诊断日志：${path.join(app.getPath('userData'), 'startup-error.log')}`); } catch { /* dialog is best effort */ }
  app.quit();
}

