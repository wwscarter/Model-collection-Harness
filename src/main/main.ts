import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, session, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configureEncryptionKeyProvider, createElectronSafeStorageKeyProvider } from '@utils/crypto';
import { ModelStorage } from '@core/storage/ModelStorage';
import { SessionStorage, type SessionRecord } from '@core/storage/SessionStorage';
import { ProjectStorage } from '@core/storage/ProjectStorage';
import { inspectProject } from '@core/project/ProjectInspector';
import { ModelRegistry } from '@core/models/ModelRegistry';
import { credentialOrigin, hasUsableCredentials, type ModelConfig, type ModelConfigInput } from '@core/models/ModelConfig';
import { AgentRouter } from '@core/routing/AgentRouter';
import { DEFAULT_ROUTING_POLICY, loadRoutingPolicy, RoutingPolicyEngine } from '@core/routing/RoutingPolicy';
import { ModelQuota } from '@core/routing/ModelQuota';
import { shouldFallback } from '@core/routing/Fallback';
import { buildExecutionPlan, chooseRevisionModel } from '@core/agent/RunOrchestrator';
import { BudgetExceededError, RunBudget } from '@core/routing/RunBudget';
import { buildRevisionPrompt, hasCode, shouldRevise, verifyCodeAnswer } from '@core/agent/VerificationService';
import { createProvider, type ModelResponse } from '@core/providers/ModelProvider';
import { fetchModelIdentifiers, testModelConnection, type ModelConnectionInput } from '@core/providers/ModelConnection';
import { buildParallelAgentPrompt, buildPlannedTask, buildPlanningPrompt, buildSynthesisPrompt, runParallelAgents, selectPlanningModel, selectUtilityModel } from '@core/routing/ModelCollaboration';
import { ObservabilityEngine, type ModelInvocation } from '@core/observability/ObservabilityEngine';
import { AuditLog } from '@core/audit/AuditLog';
import { CodeAuditor } from '@core/audit/CodeAuditor';
import { auditCodeAnswer } from '@core/audit/AuditService';
import { TraceRecorder, type TraceSpanHandle } from '@core/trace/TraceRecorder';
import type { RunStatus } from '@core/trace/types';
import { GrowthEngine, type RoutingFeedback } from '@core/growth/GrowthEngine';
import { TtyManager } from '@core/tty/TtyManager';
import { ProjectManager } from '@core/project/ProjectManager';
import type { ProjectContextResult } from '@core/project/ProjectContext';
import { assembleContext, type ContextToolDigest, type ContextTurn } from '@core/context/ContextAssembler';
import { summarizeContext } from '@core/context/SummaryService';
import { MemoryStore, type MemoryKind } from '@core/memory/MemoryStore';
import { retrieveMemories } from '@core/memory/MemoryRetriever';
import { createMemoryTools } from '@core/tools/memoryTools';
import { extractMemories } from '@core/memory/MemoryExtractor';
import { CommandExecutor, type CommandExecutionRequest } from '@core/tty/CommandExecutor';
import { ProjectProcessManager } from '@core/tty/ProjectProcessManager';
import { createProjectCommandTools } from '@core/tools/projectCommandTools';
import { AgentRuntime, type ToolEvent } from '@core/agent/AgentRuntime';
import { executeRun, type RunDependencies, type RunRequest } from '@core/agent/RunCoordinator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
let mainWindow: BrowserWindow | null = null;
let storage: ModelStorage;
let sessionStorage: SessionStorage;
let projectStorage: ProjectStorage;
let registry: ModelRegistry;
let router: AgentRouter;
let routingPolicy: RoutingPolicyEngine;
let routingRulesPath = '';
let routingHistoryDir = '';
let modelQuota: ModelQuota;
let observability: ObservabilityEngine;
let auditLog: AuditLog;
let growth: GrowthEngine;
let tty: TtyManager;
let projects: ProjectManager;
let commandExecutor: CommandExecutor;
let projectProcesses: ProjectProcessManager;
let agentRuntime: AgentRuntime;
let codeAuditor: CodeAuditor;
let traceRecorder: TraceRecorder;
let memoryStore: MemoryStore;
let workspaceRoot = '';
let preferencesPath = '';
type ApprovalMode = 'ask' | 'auto' | 'full';
let approvalMode: ApprovalMode = 'ask';
const ttyUnsubscribers = new Map<string, () => void>();
const commandUnsubscribers = new Map<string, () => void>();
/** One controller per running task so the renderer can cancel it. */
const runningTasks = new Map<string, AbortController>();

function estimateTokens(value: string): number { return Math.max(1, Math.ceil(value.length / 4)); }
function costOf(inputTokens: number, outputTokens: number, model: Pick<ModelConfig, 'costPer1kTokens'>): number {
  return (inputTokens * model.costPer1kTokens.input + outputTokens * model.costPer1kTokens.output) / 1000;
}

/** Learning data is best-effort; a full disk must not discard a finished answer. */
function recordGrowth(feedback: RoutingFeedback): void {
  try { growth.recordFeedback(feedback); } catch (error) { console.error('Growth feedback failed', error); }
}

const SAFE_TOOLS = new Set(['web_search', 'web_fetch', 'read', 'ls', 'process_status', 'process_list', 'remember', 'recall']);

function isDangerousCommand(command: string): boolean {
  return /(^|[;&|]\s*)(sudo|su|shutdown|reboot|diskutil|mkfs|dd\s+if=|rm\s+-rf\s+\/|chmod\s+-R\s+777|:?\(\)\s*\{)/i.test(command)
    || /(curl|wget)[^|]*\|\s*(ba|z|da)?sh/i.test(command);
}

function loadApprovalMode(file: string): ApprovalMode {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { approvalMode?: unknown };
    return value.approvalMode === 'auto' || value.approvalMode === 'full' ? value.approvalMode : 'ask';
  } catch { return 'ask'; }
}

function savePreferences(): void {
  try {
    fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
    fs.writeFileSync(preferencesPath, JSON.stringify({ approvalMode }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (error) { console.error('Failed to save preferences', error); }
}

/** Read operations run directly. Mutations follow the user-selected approval mode. */
async function approveToolCall({ toolName, input, projectRoot }: { toolName: string; input: Record<string, unknown>; projectRoot?: string }): Promise<string | undefined> {
  if (SAFE_TOOLS.has(toolName)) return undefined;
  const dangerous = toolName === 'run_command' && isDangerousCommand(String(input.command ?? ''));
  if (approvalMode === 'full' || (approvalMode === 'auto' && !dangerous)) return undefined;
  const labels: Record<string, string> = { write: '写入项目文件', edit: '编辑项目文件', run_command: input.background ? '启动后台服务' : '执行项目命令', stop_process: '停止后台服务' };
  const preview = toolName === 'run_command' ? String(input.command ?? '') : JSON.stringify(input, null, 2).slice(0, 1600);
  const detail = `${projectRoot ? `项目目录：${displayPath(projectRoot)}\n\n` : ''}${preview}${toolName === 'run_command' ? '\n\n命令以当前系统用户权限运行。' : ''}`;
  const options = { type: 'question' as const, buttons: ['拒绝', '允许本次调用'], defaultId: 0, cancelId: 0, title: '工具调用确认', message: `模型请求${labels[toolName] ?? `调用工具「${toolName}」`}`, detail, noLink: true };
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  return response === 1 ? undefined : '用户拒绝了这次工具调用';
}

type HistoryTurn = ContextTurn;

function sanitizeHistory(value: unknown): HistoryTurn[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-40).flatMap((turn): HistoryTurn[] => {
    const candidate = turn as Partial<HistoryTurn> | null;
    if (!candidate || (candidate.role !== 'user' && candidate.role !== 'assistant') || typeof candidate.content !== 'string') return [];
    const tools: ContextToolDigest[] = Array.isArray(candidate.tools)
      ? candidate.tools.slice(0, 30).flatMap((tool): ContextToolDigest[] => {
        if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !tool.name) return [];
        return [{
          name: tool.name.slice(0, 100),
          status: typeof tool.status === 'string' ? tool.status.slice(0, 20) : undefined,
          label: typeof tool.label === 'string' ? tool.label.slice(0, 300) : undefined,
          summary: typeof tool.summary === 'string' ? tool.summary.slice(0, 600) : undefined,
        }];
      })
      : [];
    return [{ role: candidate.role, content: candidate.content.slice(0, 40_000), ...(tools.length ? { tools } : {}) }];
  });
}

async function invokeStreamed(model: ModelConfig, prompt: string, maxTokens: number, onDelta: (delta: string) => void, options: { history?: HistoryTurn[]; summary?: string; skipHistoryTrim?: boolean; enableTools?: boolean; projectRoot?: string; projectAccess?: 'read' | 'write'; signal?: AbortSignal; onToolEvent?: (event: ToolEvent) => void } = {}): Promise<ModelResponse> {
  if (options.signal?.aborted) throw new Error('任务已取消');
  // Never turn a missing credential into a plausible-looking "demo" answer:
  // the router filters these models, and a direct call fails loudly instead.
  if (!hasUsableCredentials(model)) throw new Error(`模型「${model.name}」尚未配置 API Key，无法执行任务`);
  const result = await agentRuntime.run({
    model, prompt, history: options.history, summary: options.summary, skipHistoryTrim: options.skipHistoryTrim, maxTokens: Math.min(model.maxTokens ?? maxTokens, maxTokens),
    enableTools: options.enableTools !== false,
    projectRoot: options.projectRoot, projectAccess: options.projectAccess, signal: options.signal, onTextDelta: onDelta, onToolEvent: options.onToolEvent,
  });
  return { content: result.content, inputTokens: result.inputTokens || estimateTokens(prompt), outputTokens: result.outputTokens || estimateTokens(result.content), modelId: model.id };
}

function publicModel(model: ModelConfig) {
  const { apiKey, ...safe } = model;
  return { ...safe, hasApiKey: Boolean(apiKey) };
}

function makeId(input: ModelConfigInput): string {
  return input.id?.trim() || `${input.provider}-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now()}`;
}

/** Roots the user picked through the native folder dialog in this run. Together with
 * stored projects, these are the only roots the renderer may open or create. */
const pickedProjectRoots = new Set<string>();

function displayPath(root: string): string {
  const home = os.homedir();
  return root === home || root.startsWith(home + path.sep) ? `~${root.slice(home.length)}` : root;
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${label}无效`);
  return value.trim();
}

function resolveExistingRoot(value: unknown): string {
  const root = requireString(value, '项目目录', 4096);
  try { return fs.realpathSync(root); } catch { throw new Error(`项目目录不存在或已被移动：${displayPath(root)}`); }
}

function normalizeProjectName(value: unknown): string {
  const name = requireString(value, '项目名称', 200).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name.length > 80) throw new Error('项目名称需为 1–80 个字符');
  return name;
}

function describeProject(root: string) {
  const inspection = inspectProject(root);
  const record = projectStorage.getByRoot(inspection.root);
  return { ...inspection, id: record?.id, name: record?.name ?? inspection.suggestedName, displayRoot: displayPath(inspection.root) };
}

function openProjectRoot(root: string, name?: string) {
  try {
    const info = projects.select(root);
    projectStorage.recordOpened(info.root, name);
    return describeProject(info.root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`项目目录不存在或已被移动：${displayPath(root)}`);
    throw error;
  }
}

function resolveMetricsRange(options?: { range?: '24h' | '7d' | '30d'; from?: string; to?: string }) {
  if (options?.from || options?.to) return { from: options.from, to: options.to };
  const to = new Date();
  const hours = options?.range === '24h' ? 24 : options?.range === '30d' ? 30 * 24 : 7 * 24;
  return { from: new Date(to.getTime() - hours * 60 * 60 * 1000), to };
}

const APP_INDEX_SUFFIX = '/renderer/index.html';

/** Only newAi's own page may send IPC. A navigated or injected page must not reach main. */
function isAppUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) return url.origin === new URL(devUrl).origin;
    return url.protocol === 'file:' && url.pathname.endsWith(APP_INDEX_SUFFIX);
  } catch {
    return false;
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isAppUrl(event.senderFrame?.url ?? '')) throw new Error('不受信任的调用来源，已拒绝本次 IPC 请求');
}

/** Register every handler behind the same sender check. */
function handle<T extends unknown[]>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: T) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return listener(event, ...(args as T));
  });
}

/** The renderer cannot approve its own command; the main process shows the native dialog. */
async function confirmCommand(command: string, cwd: string): Promise<boolean> {
  if (approvalMode === 'full' || (approvalMode === 'auto' && !isDangerousCommand(command))) return true;
  const options = {
    type: 'warning' as const,
    buttons: ['取消', '执行命令'],
    defaultId: 0,
    cancelId: 0,
    title: '命令执行确认',
    message: '模型或终端请求执行一条本地命令',
    detail: `工作目录：${displayPath(cwd)}\n\n${command.slice(0, 4000)}${command.length > 4000 ? '\n…（已截断）' : ''}\n\n命令以当前系统用户权限运行。`,
    noLink: true,
  };
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  return response === 1;
}

function createRunDependencies(controller: AbortController): RunDependencies {
  return {
    models: registry,
    routing: routingPolicy,
    quota: modelQuota,
    traces: traceRecorder,
    observability,
    growth,
    codeAuditor,
    auditLog,
    memory: memoryStore,
    summaries: sessionStorage,
    projectContext: {
      getRoot: () => projects.getRoot(),
      getContextAsync: (paths?: string[], maxTokens?: number) => projects.getContextAsync(paths, maxTokens),
    },
    invokeStreamed: (model, prompt, maxTokens, onDelta, options) => invokeStreamed(model, prompt, maxTokens, onDelta, options),
    controller,
  };
}

function registerHandlers(): void {
  handle('session:list', () => sessionStorage.list());
  handle('session:get', (_event, id: string) => sessionStorage.get(id));
  handle('session:save', (_event, session: SessionRecord) => {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !session.id) throw new Error('会话数据无效');
    return sessionStorage.save({ ...session, createdAt: session.createdAt ? new Date(session.createdAt) : new Date(), updatedAt: session.updatedAt ? new Date(session.updatedAt) : new Date() });
  });
  handle('session:delete', (_event, id: unknown) => typeof id === 'string' ? ({ success: sessionStorage.delete(id) }) : { success: false });
  handle('model:list', () => registry.getAllModels().map(publicModel));
  handle('model:list-enabled', () => registry.getEnabledModels().map(publicModel));
  handle('model:register', (_event, input: ModelConfigInput) => {
    if (!input || typeof input !== 'object') throw new Error('模型配置无效');
    if (input.isPrimary && !hasUsableCredentials({ provider: input.provider, apiKey: input.apiKey ?? '', baseURL: input.baseURL })) throw new Error('该模型尚未配置可用的 API Key，不能设为主力路由');
    const now = new Date();
    const config: ModelConfig = { ...input, id: makeId(input), createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now } as ModelConfig;
    const saved = registry.registerModel(config);
    return publicModel(saved);
  });
  handle('model:update', (_event, id: string, updates: Partial<ModelConfig>) => {
    if (!updates || typeof updates !== 'object') throw new Error('模型更新参数无效');
    const existing = registry.getModel(id);
    if (!existing) throw new Error(`Model not found: ${id}`);
    let next = updates;
    // Changing the endpoint origin invalidates the stored key. Settings leaves
    // apiKey empty when the field is untouched, which used to keep sending the
    // old secret to the new host.
    const nextProvider = updates.provider ?? existing.provider;
    if (updates.baseURL !== undefined && updates.apiKey === undefined && credentialOrigin(existing.provider, existing.baseURL) !== credentialOrigin(nextProvider, updates.baseURL)) {
      next = { ...updates, apiKey: '' };
    }
    if (next.isPrimary && !hasUsableCredentials({ ...existing, ...next })) throw new Error('该模型尚未配置可用的 API Key，不能设为主力路由');
    const updated = registry.updateModel(id, next);
    if (!updated) throw new Error(`Model not found: ${id}`);
    return publicModel(updated);
  });
  handle('model:delete', (_event, id: string) => ({ success: registry.deleteModel(id) }));
  handle('model:set-primary', (_event, id: string) => {
    const model = registry.getModel(id);
    if (!model) throw new Error(`Model not found: ${id}`);
    if (!hasUsableCredentials(model)) throw new Error('该模型尚未配置可用的 API Key，不能设为主力路由');
    return registry.setPrimaryModel(id).map(publicModel);
  });
  handle('model:fetch-models', (_event, input: ModelConnectionInput) => fetchModelIdentifiers(input, registry));
  handle('model:test-draft', (_event, input: ModelConnectionInput) => testModelConnection(input, registry));
  handle('model:test-connection', async (_event, id: string) => {
    const model = registry.getModel(id);
    if (!model) throw new Error(`Model not found: ${id}`);
    return { ...await testModelConnection({ id, provider: model.provider }, registry), model: publicModel(model) };
  });
  handle('routing:status', () => router.getLocalModelStatus());
  handle('routing:rules:get', () => ({
    path: routingRulesPath,
    text: fs.existsSync(routingRulesPath) ? fs.readFileSync(routingRulesPath, 'utf8') : `${JSON.stringify(DEFAULT_ROUTING_POLICY, null, 2)}\n`,
  }));
  handle('routing:rules:set', (_event, text: unknown) => {
    if (typeof text !== 'string' || text.length > 100_000) throw new Error('路由规则内容无效');
    JSON.parse(text);
    if (fs.existsSync(routingRulesPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(routingRulesPath, path.join(routingHistoryDir, `${stamp}.json`));
      const snapshots = fs.readdirSync(routingHistoryDir).filter((name) => name.endsWith('.json')).sort().reverse();
      for (const stale of snapshots.slice(20)) fs.rmSync(path.join(routingHistoryDir, stale), { force: true });
    }
    const temporary = `${routingRulesPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, routingRulesPath);
    const state = loadRoutingPolicy(routingRulesPath);
    routingPolicy = new RoutingPolicyEngine(router, state.policy);
    return { policy: state.policy, diagnostics: state.diagnostics };
  });
  handle('routing:rules:history', () => fs.readdirSync(routingHistoryDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 20)
    .map((name) => ({ name, savedAt: fs.statSync(path.join(routingHistoryDir, name)).mtime.toISOString() })));
  handle('routing:rules:restore', (_event, name: unknown) => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+\.json$/.test(name)) throw new Error('历史版本名称无效');
    const snapshot = path.join(routingHistoryDir, name);
    if (!fs.existsSync(snapshot)) throw new Error('历史版本不存在');
    const text = fs.readFileSync(snapshot, 'utf8');
    JSON.parse(text);
    const temporary = `${routingRulesPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, routingRulesPath);
    const state = loadRoutingPolicy(routingRulesPath);
    routingPolicy = new RoutingPolicyEngine(router, state.policy);
    return { text, policy: state.policy, diagnostics: state.diagnostics };
  });
  handle('session:execute', async (_event, payload: RunRequest) => {
    if (!payload || typeof payload.prompt !== 'string' || !payload.prompt.trim()) throw new Error('任务描述不能为空');
    if (payload.prompt.length > 200_000) throw new Error('任务描述过长');
    const sessionId = payload.sessionId || payload.taskId || randomUUID();
    const request: RunRequest = { ...payload, sessionId };
    const controller = new AbortController();
    runningTasks.get(sessionId)?.abort();
    runningTasks.set(sessionId, controller);
    try {
      return await executeRun(request, createRunDependencies(controller), (channel, value) => mainWindow?.webContents.send(channel, value));
    } finally {
      if (runningTasks.get(sessionId) === controller) runningTasks.delete(sessionId);
    }
  });
  handle('session:cancel', (_event, taskId: unknown) => {
    if (typeof taskId !== 'string') return { success: false };
    runningTasks.get(taskId)?.abort();
    return { success: runningTasks.has(taskId) };
  });
  handle('agent:describe', () => agentRuntime.describe());
  handle('agent:search-providers', () => agentRuntime.search.list());
  handle('agent:set-search-provider', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('无效的搜索后端');
    agentRuntime.search.setActive(id);
    return agentRuntime.search.list();
  });
  handle('trace:get', (_event, runId: unknown) => typeof runId === 'string' ? traceRecorder.getTrace(runId) : undefined);
  handle('trace:recent', (_event, sessionId: unknown, limit?: number) => typeof sessionId === 'string' ? traceRecorder.listRecent(sessionId, limit) : []);
  handle('trace:list', (_event, limit?: number) => traceRecorder.listRecentRuns(limit));
  handle('trace:settings:get', () => observability.getTraceRetention());
  handle('trace:settings:set', (_event, options: unknown) => {
    if (!options || typeof options !== 'object') throw new Error('Trace 保留设置无效');
    const value = options as { maxAgeDays?: unknown; maxRuns?: unknown };
    return observability.setTraceRetention({
      maxAgeDays: typeof value.maxAgeDays === 'number' ? value.maxAgeDays : undefined,
      maxRuns: typeof value.maxRuns === 'number' ? value.maxRuns : undefined,
    });
  });
  handle('trace:clear', () => observability.clearTraces());
  handle('preferences:get', () => ({ approvalMode }));
  handle('preferences:set', (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('设置无效');
    const value = input as { approvalMode?: unknown };
    if (value.approvalMode !== 'ask' && value.approvalMode !== 'auto' && value.approvalMode !== 'full') throw new Error('权限模式无效');
    approvalMode = value.approvalMode;
    savePreferences();
    return { approvalMode };
  });
  handle('memory:list', (_event, options?: { scope?: 'global' | 'project' | 'session' } | null) => {
    const projectRoot = projects.getRoot();
    const scope = options?.scope;
    const records = scope === 'global' ? memoryStore.list({ scopes: ['global'], status: 'all' })
      : scope === 'project' ? (projectRoot ? memoryStore.list({ scopes: ['project'], projectRoot, status: 'all' }) : [])
        : [
          ...memoryStore.list({ scopes: ['global'], status: 'all' }),
          ...(projectRoot ? memoryStore.list({ scopes: ['project'], projectRoot, status: 'all' }) : []),
        ];
    return records.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 200);
  });
  handle('memory:add', (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('记忆参数无效');
    const value = input as { content?: unknown; kind?: unknown; scope?: unknown; tags?: unknown };
    if (typeof value.content !== 'string') throw new Error('记忆内容无效');
    const projectRoot = projects.getRoot();
    const scope = value.scope === 'global' ? 'global' : projectRoot ? 'project' : 'global';
    const kinds: MemoryKind[] = ['preference', 'fact', 'decision', 'todo', 'artifact'];
    const kind = typeof value.kind === 'string' && kinds.includes(value.kind as MemoryKind) ? value.kind as MemoryKind : 'fact';
    return memoryStore.add({
      content: value.content,
      kind,
      scope,
      projectRoot: scope === 'project' ? projectRoot : undefined,
      source: 'user',
      tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    });
  });
  handle('memory:remove', (_event, id: unknown) => typeof id === 'string' ? { success: memoryStore.remove(id) } : { success: false });
  handle('memory:approve', (_event, id: unknown) => typeof id === 'string' ? { success: memoryStore.approve(id) } : { success: false });
  handle('memory:approve-many', (_event, ids: unknown) => ({ count: Array.isArray(ids) ? memoryStore.approveMany(ids) : 0 }));
  handle('memory:remove-many', (_event, ids: unknown) => ({ count: Array.isArray(ids) ? memoryStore.removeMany(ids) : 0 }));
  handle('memory:export', () => memoryStore.exportAll());
  handle('memory:clear', () => ({ removed: memoryStore.clear() }));
  handle('memory:settings', () => ({ autoExtract: memoryStore.getAutoExtract() }));
  handle('memory:set-auto-extract', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('自动提取设置无效');
    memoryStore.setAutoExtract(enabled);
    return { autoExtract: enabled };
  });
  handle('metrics:task', (_event, taskId: string) => observability.getTaskMetrics(taskId));
  handle('metrics:recent', (_event, limit?: number) => observability.getRecent(limit));
  handle('metrics:dashboard', (_event, options?: { range?: '24h' | '7d' | '30d'; from?: string; to?: string }) => observability.getDashboardSnapshot(resolveMetricsRange(options)));
  handle('metrics:report', (_event, options?: { range?: '24h' | '7d' | '30d'; from?: string; to?: string }) => observability.getReportMarkdown(resolveMetricsRange(options)));
  handle('audit:verify', () => auditLog.verify());
  handle('project:current', () => {
    const root = projects.getRoot();
    if (!root) return undefined;
    try { return describeProject(root); } catch { return { ...projects.getInfo()!, displayRoot: displayPath(root), languages: [], markers: [] }; }
  });
  handle('project:select', async (_event, requestedRoot?: unknown) => {
    if (requestedRoot !== undefined) {
      // Only roots the user already chose (dialog or stored list) may be reopened by path.
      const root = resolveExistingRoot(requestedRoot);
      if (!pickedProjectRoots.has(root) && !projectStorage.getByRoot(root)) throw new Error('请通过文件夹选择对话框选择项目目录');
      return openProjectRoot(root);
    }
    const options: OpenDialogOptions = { title: '选择项目文件夹', properties: ['openDirectory', 'createDirectory'] };
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return undefined;
    return openProjectRoot(selected.filePaths[0]);
  });
  handle('project:clear', () => { projects.clear(); return { success: true }; });
  handle('project:tree', (_event, options?: { path?: string; maxDepth?: number }) => projects.getTree(options?.path, options?.maxDepth));
  handle('project:context', async (_event, options?: { paths?: string[]; maxTokens?: number }) => projects.getContextAsync(options?.paths, options?.maxTokens));
  handle('project:file', (_event, relativePath: unknown) => {
    if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 1_000) throw new Error('文件路径无效');
    const file = projects.readFile(relativePath);
    if (!file) throw new Error('项目尚未打开或文件不存在');
    return file;
  });
  handle('project:init-git', async () => {
    const root = projects.getRoot();
    if (!root) throw new Error('请先选择项目');
    if (describeProject(root).git) return describeProject(root);
    try {
      await execFileAsync('git', ['init'], { cwd: root, timeout: 15_000, windowsHide: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error('无法创建 Git 存储库：' + message);
    }
    projectStorage.recordOpened(root);
    return describeProject(root);
  });
  handle('projects:list', () => {
    const activeRoot = projects.getRoot();
    return projectStorage.list().map((project) => ({ ...project, displayRoot: displayPath(project.root), active: project.root === activeRoot }));
  });
  handle('projects:open', (_event, id: unknown) => {
    const project = projectStorage.get(requireString(id, '项目 ID', 100));
    if (!project) throw new Error('项目记录不存在，请刷新列表');
    return openProjectRoot(project.root);
  });
  handle('projects:remove', (_event, id: unknown) => {
    const project = projectStorage.get(requireString(id, '项目 ID', 100));
    if (!project) return { success: false };
    if (projects.getRoot() === project.root) projects.clear();
    return { success: projectStorage.remove(project.id) };
  });
  handle('projects:pick-directory', async () => {
    const options: OpenDialogOptions = { title: '选择要绑定的项目文件夹', buttonLabel: '选择', properties: ['openDirectory', 'createDirectory'] };
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return undefined;
    const info = describeProject(selected.filePaths[0]);
    pickedProjectRoots.add(info.root);
    return { ...info, existing: Boolean(info.id) };
  });
  handle('projects:create', (_event, input: unknown) => {
    const { root, name } = (input ?? {}) as { root?: unknown; name?: unknown };
    const resolved = resolveExistingRoot(root);
    if (!pickedProjectRoots.has(resolved) && !projectStorage.getByRoot(resolved)) throw new Error('请通过文件夹选择对话框选择项目目录');
    return openProjectRoot(resolved, normalizeProjectName(name));
  });
  handle('growth:profiles', () => growth.getProfiles());
  handle('growth:feedback', (_event, feedback: RoutingFeedback) => growth.recordFeedback(feedback));
  handle('tty:list', () => tty.listSessions());
  handle('tty:create', async (_event, options?: { cols?: number; rows?: number }) => {
    // The renderer may choose the grid size only. Shell, cwd and env stay under
    // main-process control; otherwise a navigated page could spawn a shell with
    // the app's full environment.
    if (tty.listSessions().filter((session) => session.status === 'running').length >= 8) throw new Error('终端会话数量已达上限（8 个）');
    const cwd = projects.getRoot() ?? workspaceRoot;
    const info = await tty.createSession({ cwd, cols: options?.cols, rows: options?.rows });
    const unsubscribe = tty.onData(info.id, (data) => mainWindow?.webContents.send('tty:data', { sessionId: info.id, data }));
    ttyUnsubscribers.set(info.id, unsubscribe);
    return info;
  });
  handle('tty:write', (_event, id: string, data: string) => tty.write(id, data));
  handle('tty:resize', (_event, id: string, cols: number, rows: number) => tty.resize(id, cols, rows));
  handle('tty:close', (_event, id: string) => { const closed = tty.close(id); ttyUnsubscribers.get(id)?.(); ttyUnsubscribers.delete(id); return closed; });
  handle('execution:run', async (_event, request: CommandExecutionRequest) => {
    const selectedProjectRoot = projects.getRoot();
    if (!selectedProjectRoot) throw new Error('Select a project before running a command');
    if (!request || typeof request.command !== 'string' || !request.command.trim()) throw new Error('Command cannot be empty');
    const requestedCwd = request.cwd ? path.resolve(selectedProjectRoot, request.cwd) : selectedProjectRoot;
    const relative = path.relative(selectedProjectRoot, requestedCwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Working directory must stay inside the project root');
    // `approved` from the renderer is intentionally ignored. Authorization is a
    // user decision made in this process, not a boolean supplied by the page.
    if (!(await confirmCommand(request.command, requestedCwd))) throw new Error('用户取消了命令执行');
    // The main process is the authority for the sandbox boundary: commands run in
    // the selected project, with a filtered environment, and without renderer
    // supplied `env`/`approved` fields.
    const execution = commandExecutor.start({ command: request.command, cwd: requestedCwd, timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes, projectRoot: selectedProjectRoot, approved: true });
    const unsubscribe = commandExecutor.onData(execution.id, (event) => mainWindow?.webContents.send('execution:data', { executionId: execution.id, ...event }));
    commandUnsubscribers.set(execution.id, unsubscribe);
    try { return await execution.promise; }
    finally { unsubscribe(); commandUnsubscribers.delete(execution.id); }
  });
  handle('execution:cancel', (_event, id: unknown) => typeof id === 'string' ? commandExecutor.cancel(id) : false);
}

function installSessionHardening(): void {
  // Only the clipboard write used by the copy buttons is allowed. Camera,
  // microphone, notifications, geolocation and USB stay denied by default.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
}

/** Applies to every WebContents, including ones created before our window listeners. */
function hardenWebContents(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0A0A0A' : '#FFFFFF',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 21 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    }
  });
  nativeTheme.on('updated', () => { mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0A0A0A' : '#FFFFFF'); });
  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  workspaceRoot = path.join(app.getPath('userData'), 'workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const keyPath = path.join(app.getPath('userData'), 'credentials.key');
  // An explicit environment key is the documented recovery path when the OS
  // keyring is unavailable or credentials.key was lost.
  if (process.env.AMD_ENCRYPTION_KEY) configureEncryptionKeyProvider(() => process.env.AMD_ENCRYPTION_KEY!);
  else configureEncryptionKeyProvider(createElectronSafeStorageKeyProvider({ keyPath, safeStorage }));
  storage = new ModelStorage(path.join(app.getPath('userData'), 'amd.db'));
  sessionStorage = new SessionStorage(path.join(app.getPath('userData'), 'sessions.db'));
  projectStorage = new ProjectStorage(path.join(app.getPath('userData'), 'projects.db'));
  registry = new ModelRegistry(storage, { initializePresets: true, persist: true });
  // Never enable a preset that cannot make a real request. A fresh install has no
  // credentials, and silently selecting GPT-4 used to produce demo answers.
  if (!registry.getEnabledModels().some(hasUsableCredentials)) {
    const usable = registry.getAllModels().find(hasUsableCredentials);
    if (usable) registry.updateModel(usable.id, { enabled: true });
  }
  growth = new GrowthEngine({ storagePath: path.join(app.getPath('userData'), 'growth-profiles.json') });
  router = new AgentRouter(registry, growth);
  preferencesPath = path.join(app.getPath('userData'), 'preferences.json');
  approvalMode = loadApprovalMode(preferencesPath);
  routingRulesPath = path.join(app.getPath('userData'), 'routing-rules.json');
  routingHistoryDir = path.join(app.getPath('userData'), 'routing-rules.history');
  fs.mkdirSync(routingHistoryDir, { recursive: true });
  const routingPolicyState = loadRoutingPolicy(routingRulesPath);
  routingPolicy = new RoutingPolicyEngine(router, routingPolicyState.policy);
  for (const diagnostic of routingPolicyState.diagnostics) console.warn('[routing]', diagnostic);
  tty = new TtyManager({ defaultCwd: workspaceRoot });
  projects = new ProjectManager();
  commandExecutor = new CommandExecutor();
  projectProcesses = new ProjectProcessManager();
  // Pi resources (skills/, extensions/, mcp.json) live in newAi's own data folder, never ~/.pi.
  // No project selected means an empty app-owned workspace, not ~/Documents.
  agentRuntime = new AgentRuntime({
    agentDir: path.join(app.getPath('userData'), 'agent'), defaultCwd: workspaceRoot,
    toolGate: approveToolCall, enableMcp: true,
    extraTools: ({ projectRoot }) => [
      ...(projectRoot ? createProjectCommandTools(projectRoot, projectProcesses) : []),
      ...createMemoryTools(memoryStore, { projectRoot }),
    ],
  });
  observability = new ObservabilityEngine(path.join(app.getPath('userData'), 'metrics.db'));
  modelQuota = new ModelQuota(observability);
  memoryStore = new MemoryStore(path.join(app.getPath('userData'), 'memory.db'));
  traceRecorder = new TraceRecorder(observability, {
    onEvent: (event) => { mainWindow?.webContents.send('session:trace', event); },
  });
  try { observability.pruneTraces(observability.getTraceRetention()); } catch (error) { console.warn('Trace retention failed', error); }
  auditLog = new AuditLog(path.join(app.getPath('userData'), 'audit.jsonl'));
  codeAuditor = new CodeAuditor();
  installSessionHardening();
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));
  registerHandlers();
  createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow(); });
  if (!process.env.AMD_ENCRYPTION_KEY && !safeStorage.isEncryptionAvailable()) {
    const options = {
      type: 'warning' as const,
      title: '系统密钥库不可用',
      message: '无法使用系统密钥库加密 API Key',
      detail: '应用仍可启动，但已保存的凭据无法解密，新凭据也无法保存。请检查系统钥匙串，或设置 AMD_ENCRYPTION_KEY 后重新启动。损坏的模型会显示“需重新输入”。',
      buttons: ['知道了'],
    };
    if (mainWindow) void dialog.showMessageBox(mainWindow, options); else void dialog.showMessageBox(options);
  }
}

/** Keep the failure visible and recoverable instead of quitting with only a console line. */
function reportStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'startup-error.log'), `${new Date().toISOString()}\n${error instanceof Error ? error.stack ?? message : message}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* best effort */ }
  console.error('AMD Agent failed to start', error);
  try { dialog.showErrorBox('newAi 启动失败', `${message}\n\n诊断日志：${path.join(app.getPath('userData'), 'startup-error.log')}`); } catch { /* dialog is best effort */ }
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  // A second instance would open the same SQLite files and process manager.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  bootstrap().catch(reportStartupFailure);
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { for (const controller of runningTasks.values()) controller.abort(); tty?.dispose(); commandExecutor?.dispose(); projectProcesses?.dispose(); storage?.close(); sessionStorage?.close(); projectStorage?.close(); observability?.close(); memoryStore?.close(); });
