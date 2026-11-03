import { app, BrowserWindow, dialog, ipcMain, safeStorage, type OpenDialogOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configureEncryptionKeyProvider, createElectronSafeStorageKeyProvider } from '@utils/crypto';
import { ModelStorage } from '@core/storage/ModelStorage';
import { SessionStorage, type SessionRecord } from '@core/storage/SessionStorage';
import { ProjectStorage } from '@core/storage/ProjectStorage';
import { inspectProject } from '@core/project/ProjectInspector';
import { ModelRegistry } from '@core/models/ModelRegistry';
import type { ModelConfig, ModelConfigInput } from '@core/models/ModelConfig';
import { AgentRouter } from '@core/routing/AgentRouter';
import { createProvider, type ModelResponse } from '@core/providers/ModelProvider';
import { fetchModelIdentifiers, testModelConnection, type ModelConnectionInput } from '@core/providers/ModelConnection';
import { buildParallelAgentPrompt, buildPlannedTask, buildPlanningPrompt, buildSynthesisPrompt, runParallelAgents, selectPlanningModel } from '@core/routing/ModelCollaboration';
import { ObservabilityEngine } from '@core/observability/ObservabilityEngine';
import { AuditLog } from '@core/audit/AuditLog';
import { GrowthEngine, type RoutingFeedback } from '@core/growth/GrowthEngine';
import { TtyManager } from '@core/tty/TtyManager';
import { ProjectManager } from '@core/project/ProjectManager';
import { CommandExecutor, type CommandExecutionRequest } from '@core/tty/CommandExecutor';
import { AgentRuntime, type ToolEvent } from '@core/agent/AgentRuntime';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let storage: ModelStorage;
let sessionStorage: SessionStorage;
let projectStorage: ProjectStorage;
let registry: ModelRegistry;
let router: AgentRouter;
let observability: ObservabilityEngine;
let auditLog: AuditLog;
let growth: GrowthEngine;
let tty: TtyManager;
let projects: ProjectManager;
let commandExecutor: CommandExecutor;
let agentRuntime: AgentRuntime;
const ttyUnsubscribers = new Map<string, () => void>();
const commandUnsubscribers = new Map<string, () => void>();
/** One controller per running task so the renderer can cancel it. */
const runningTasks = new Map<string, AbortController>();

function estimateTokens(value: string): number { return Math.max(1, Math.ceil(value.length / 4)); }

const SAFE_TOOLS = new Set(['web_search', 'web_fetch', 'read', 'ls']);

/** Built-in tools are read-only; anything else (MCP, plugins) needs the user's consent per call. */
async function approveToolCall({ toolName, input }: { toolName: string; input: Record<string, unknown> }): Promise<string | undefined> {
  if (SAFE_TOOLS.has(toolName)) return undefined;
  const preview = JSON.stringify(input, null, 2).slice(0, 800);
  const options = { type: 'question' as const, buttons: ['拒绝', '允许本次调用'], defaultId: 0, cancelId: 0, title: '工具调用确认', message: `模型请求调用工具「${toolName}」`, detail: preview, noLink: true };
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  return response === 1 ? undefined : '用户拒绝了这次工具调用';
}

type HistoryTurn = { role: 'user' | 'assistant'; content: string };

function sanitizeHistory(value: unknown): HistoryTurn[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-40).flatMap((turn): HistoryTurn[] => {
    const candidate = turn as Partial<HistoryTurn> | null;
    if (!candidate || (candidate.role !== 'user' && candidate.role !== 'assistant') || typeof candidate.content !== 'string') return [];
    return [{ role: candidate.role, content: candidate.content.slice(0, 40_000) }];
  });
}

async function invokeStreamed(model: ModelConfig, prompt: string, maxTokens: number, onDelta: (delta: string) => void, options: { history?: HistoryTurn[]; enableTools?: boolean; signal?: AbortSignal; onToolEvent?: (event: ToolEvent) => void } = {}): Promise<ModelResponse> {
  if (options.signal?.aborted) throw new Error('任务已取消');
  // Presets without credentials keep the local demo response instead of failing the request.
  if (!model.apiKey && model.provider !== 'custom') {
    const demo = await createProvider(model).invoke(prompt);
    onDelta(demo.content);
    return demo;
  }
  const result = await agentRuntime.run({
    model, prompt, history: options.history, maxTokens: Math.min(model.maxTokens ?? maxTokens, maxTokens),
    enableTools: options.enableTools !== false,
    projectRoot: projects.getRoot(), signal: options.signal, onTextDelta: onDelta, onToolEvent: options.onToolEvent,
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

function registerHandlers(): void {
  ipcMain.handle('session:list', () => sessionStorage.list());
  ipcMain.handle('session:get', (_event, id: string) => sessionStorage.get(id));
  ipcMain.handle('session:save', (_event, session: SessionRecord) => sessionStorage.save({ ...session, createdAt: session.createdAt ? new Date(session.createdAt) : new Date(), updatedAt: session.updatedAt ? new Date(session.updatedAt) : new Date() }));
  ipcMain.handle('session:delete', (_event, id: string) => ({ success: sessionStorage.delete(id) }));
  ipcMain.handle('model:list', () => registry.getAllModels().map(publicModel));
  ipcMain.handle('model:list-enabled', () => registry.getEnabledModels().map(publicModel));
  ipcMain.handle('model:register', (_event, input: ModelConfigInput) => {
    const now = new Date();
    const config: ModelConfig = { ...input, id: makeId(input), createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now } as ModelConfig;
    const saved = registry.registerModel(config);
    return publicModel(saved);
  });
  ipcMain.handle('model:update', (_event, id: string, updates: Partial<ModelConfig>) => {
    const updated = registry.updateModel(id, updates);
    if (!updated) throw new Error(`Model not found: ${id}`);
    return publicModel(updated);
  });
  ipcMain.handle('model:delete', (_event, id: string) => ({ success: registry.deleteModel(id) }));
  ipcMain.handle('model:set-primary', (_event, id: string) => registry.setPrimaryModel(id).map(publicModel));
  ipcMain.handle('model:fetch-models', (_event, input: ModelConnectionInput) => fetchModelIdentifiers(input, registry));
  ipcMain.handle('model:test-draft', (_event, input: ModelConnectionInput) => testModelConnection(input, registry));
  ipcMain.handle('model:test-connection', async (_event, id: string) => {
    const model = registry.getModel(id);
    if (!model) throw new Error(`Model not found: ${id}`);
    return { ...await testModelConnection({ id, provider: model.provider }, registry), model: publicModel(model) };
  });
  ipcMain.handle('routing:status', () => router.getLocalModelStatus());
  ipcMain.handle('session:execute', async (_event, payload: { sessionId?: string; taskId?: string; assistantMessageId?: string; prompt: string; taskType?: string; complexity?: 'low' | 'medium' | 'high'; stream?: boolean; collaboratorModelIds?: string[]; contextPaths?: string[]; includeProjectContext?: boolean; contextMaxTokens?: number; history?: unknown; enableTools?: boolean }) => {
    const taskId = payload.taskId || randomUUID();
    const sessionId = payload.sessionId || taskId;
    const assistantMessageId = payload.assistantMessageId || `${taskId}-assistant`;
    const history = sanitizeHistory(payload.history);
    const enableTools = payload.enableTools !== false;
    const toolCalls: ToolEvent[] = [];
    const emitToolEvent = (agentId: string | undefined, event: ToolEvent) => {
      if (!agentId) {
        const index = toolCalls.findIndex((call) => call.toolCallId === event.toolCallId);
        const merged = index >= 0 ? { ...toolCalls[index], ...event, args: event.args ?? toolCalls[index].args } : event;
        if (index >= 0) toolCalls[index] = merged; else toolCalls.push(merged);
      }
      mainWindow?.webContents.send('session:tool-call', { sessionId, taskId, assistantMessageId, agentId, ...event, details: undefined });
    };
    const collaboratorIds = [...new Set(payload.collaboratorModelIds ?? [])];
    if (collaboratorIds.length === 1 || collaboratorIds.length > 4) throw new Error('并行子智能体需要选择 2–4 个不同的模型。');
    const collaboratorModels = collaboratorIds.map((id) => {
      const candidate = registry.getModel(id);
      if (!candidate || !candidate.enabled) throw new Error('子智能体只能使用已启用的模型，请检查模型配置。');
      return candidate;
    });
    const projectContext = payload.includeProjectContext === false ? undefined : projects.getContext(payload.contextPaths, payload.contextMaxTokens);
    const contextPrompt = projectContext?.text
      ? `${payload.prompt}\n\nThe following read-only project context is available. Use it as evidence and do not assume files can be modified automatically.\n${projectContext.text}`
      : payload.prompt;
    const controller = new AbortController();
    runningTasks.get(taskId)?.abort();
    runningTasks.set(taskId, controller);
    try {
      // Leave complexity undefined unless the caller explicitly supplied it. The
      // local classifier then infers low/medium/high from the actual task text.
      const decision = await router.routeTask({ id: taskId, type: (payload.taskType || 'general') as any, description: contextPrompt, complexity: payload.complexity });
      if (controller.signal.aborted) throw new Error('任务已取消');
      mainWindow?.webContents.send('session:model-switched', { sessionId, taskId, ...decision, role: 'routing' });
      const model = registry.getModel(decision.modelId);
      if (!model) throw new Error(`Routed model not found: ${decision.modelId}`);
      let executionPrompt = contextPrompt;
      let planningModelId: string | undefined;
      // High-complexity tasks can use a second model for planning, then pass the
      // verified plan to the execution model. Ordinary prompts (including "你好")
      // remain a single call so they do not incur an unnecessary second request.
      if (decision.complexity === 'high') {
        const planningModel = selectPlanningModel(registry.getEnabledModels(), model.id);
        if (planningModel) {
          planningModelId = planningModel.id;
          mainWindow?.webContents.send('session:model-switched', { sessionId, taskId, modelId: planningModel.id, role: 'planning', reason: '为高复杂度任务生成执行计划', confidence: decision.confidence });
          const planningInvocationId = observability.recordInvocationStart(taskId, planningModel.id);
          try {
            const planningContext = history.length
              ? `Conversation so far:\n${history.map((turn) => `${turn.role}: ${turn.content}`).join('\n\n')}\n\nCurrent task:\n${contextPrompt}`
              : contextPrompt;
            const plan = await createProvider(planningModel).invoke(buildPlanningPrompt(planningContext), { maxTokens: Math.min(planningModel.maxTokens ?? 1200, 1200), temperature: 0.2, signal: controller.signal });
            observability.recordInvocationEnd(planningInvocationId, plan.inputTokens, plan.outputTokens, planningModel.costPer1kTokens, 'success');
            executionPrompt = buildPlannedTask(contextPrompt, plan.content);
          } catch (error) {
            observability.recordInvocationEnd(planningInvocationId, 0, 0, planningModel.costPer1kTokens, 'failure', error instanceof Error ? error.message : String(error));
            if (controller.signal.aborted) throw new Error('任务已取消');
            planningModelId = undefined;
          }
        }
      }
      mainWindow?.webContents.send('session:model-switched', { sessionId, taskId, ...decision, modelId: model.id, role: 'execution', planningModelId });
      const invocationId = observability.recordInvocationStart(taskId, model.id);
      try {
        let result: ModelResponse;
        let agentReports: Array<{ modelName: string; content: string }> = [];
        let failedAgentCount = 0;
        const agentMessages = collaboratorModels.map((agentModel, index) => ({
          id: `${assistantMessageId}-agent-${index + 1}`,
          modelId: agentModel.id,
          modelName: agentModel.name,
          status: 'queued' as 'queued' | 'running' | 'completed' | 'failed',
          content: '',
        }));
        if (collaboratorModels.length) {
          const agentResults = await runParallelAgents(collaboratorModels, async (agentModel, index) => {
            const agentId = `${assistantMessageId}-agent-${index + 1}`;
            const agentInvocationId = observability.recordInvocationStart(taskId, agentModel.id);
            let agentContent = '';
            agentMessages[index].status = 'running';
            mainWindow?.webContents.send('session:agent-update', { sessionId, taskId, assistantMessageId, agentId, modelId: agentModel.id, modelName: agentModel.name, status: 'running' });
            try {
              const agentResult = await invokeStreamed(agentModel, buildParallelAgentPrompt(contextPrompt, index), 1800, (delta) => {
                agentContent += delta;
                agentMessages[index].content = agentContent;
                mainWindow?.webContents.send('session:agent-update', { sessionId, taskId, assistantMessageId, agentId, modelId: agentModel.id, status: 'running', delta });
              }, { history, enableTools, signal: controller.signal, onToolEvent: (event) => emitToolEvent(agentId, event) });
              observability.recordInvocationEnd(agentInvocationId, agentResult.inputTokens, agentResult.outputTokens, agentModel.costPer1kTokens, 'success');
              agentMessages[index].status = 'completed';
              agentMessages[index].content = agentResult.content;
              mainWindow?.webContents.send('session:agent-update', { sessionId, taskId, assistantMessageId, agentId, modelId: agentModel.id, status: 'completed', content: agentResult.content });
              return { modelName: agentModel.name, content: agentResult.content };
            } catch (agentError) {
              const message = agentError instanceof Error ? agentError.message : String(agentError);
              observability.recordInvocationEnd(agentInvocationId, estimateTokens(contextPrompt), estimateTokens(agentContent), agentModel.costPer1kTokens, 'failure', message);
              agentMessages[index].status = 'failed';
              agentMessages[index].content = agentContent;
              Object.assign(agentMessages[index], { error: message });
              mainWindow?.webContents.send('session:agent-update', { sessionId, taskId, assistantMessageId, agentId, modelId: agentModel.id, status: 'failed', content: agentContent, error: message });
              throw agentError;
            }
          });
          agentReports = agentResults.flatMap((agentResult) => agentResult.status === 'fulfilled' ? [agentResult.value] : []);
          failedAgentCount = agentResults.length - agentReports.length;
        }
        const finalPrompt = collaboratorModels.length
          ? buildSynthesisPrompt(executionPrompt, agentReports, failedAgentCount)
          : executionPrompt;
        let chunkIndex = 0;
        result = await invokeStreamed(model, finalPrompt, 4000, (delta) => {
          chunkIndex += 1;
          mainWindow?.webContents.send('session:chunk', { sessionId, taskId, delta, index: chunkIndex, modelId: model.id });
        }, { history, enableTools, signal: controller.signal, onToolEvent: (event) => emitToolEvent(undefined, event) });
        const metrics = observability.recordInvocationEnd(invocationId, result.inputTokens, result.outputTokens, model.costPer1kTokens, 'success');
        if (metrics) {
          growth.recordFeedback({ modelId: model.id, taskType: payload.taskType || 'general', success: true, completed: true, actualCost: metrics.totalCost, estimatedCost: decision.estimatedCost, actualLatency: metrics.latency, estimatedLatency: decision.estimatedDuration });
        }
        const output = { sessionId, taskId, assistantMessageId, output: result.content, modelUsed: publicModel(model), modelsUsed: [...(planningModelId ? [planningModelId] : []), ...collaboratorModels.map((collaborator) => collaborator.id), model.id], planningModelId, decision, metrics, agentReports, agentMessages, toolCalls: toolCalls.map(({ details: _details, ...call }) => call), project: projectContext ? { root: projectContext.root, files: projectContext.files.map((file) => file.path), tokenCount: projectContext.tokenCount, truncated: projectContext.truncated, skippedFiles: projectContext.skippedFiles } : undefined };
        mainWindow?.webContents.send('session:completed', output);
        return output;
      } catch (error) {
        observability.recordInvocationEnd(invocationId, 0, 0, model.costPer1kTokens, 'failure', error instanceof Error ? error.message : String(error));
        throw error;
      }
    } finally {
      if (runningTasks.get(taskId) === controller) runningTasks.delete(taskId);
    }
  });
  ipcMain.handle('session:cancel', (_event, taskId: unknown) => {
    if (typeof taskId !== 'string') return { success: false };
    runningTasks.get(taskId)?.abort();
    return { success: runningTasks.has(taskId) };
  });
  ipcMain.handle('agent:describe', () => agentRuntime.describe());
  ipcMain.handle('agent:search-providers', () => agentRuntime.search.list());
  ipcMain.handle('agent:set-search-provider', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('无效的搜索后端');
    agentRuntime.search.setActive(id);
    return agentRuntime.search.list();
  });
  ipcMain.handle('metrics:task', (_event, taskId: string) => observability.getTaskMetrics(taskId));
  ipcMain.handle('metrics:recent', (_event, limit?: number) => observability.getRecent(limit));
  ipcMain.handle('metrics:dashboard', (_event, options?: { range?: '24h' | '7d' | '30d'; from?: string; to?: string }) => observability.getDashboardSnapshot(resolveMetricsRange(options)));
  ipcMain.handle('metrics:report', (_event, options?: { range?: '24h' | '7d' | '30d'; from?: string; to?: string }) => observability.getReportMarkdown(resolveMetricsRange(options)));
  ipcMain.handle('audit:verify', () => auditLog.verify());
  ipcMain.handle('project:current', () => {
    const root = projects.getRoot();
    if (!root) return undefined;
    try { return describeProject(root); } catch { return { ...projects.getInfo()!, displayRoot: displayPath(root), languages: [], markers: [] }; }
  });
  ipcMain.handle('project:select', async (_event, requestedRoot?: unknown) => {
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
  ipcMain.handle('project:clear', () => { projects.clear(); return { success: true }; });
  ipcMain.handle('project:tree', (_event, options?: { path?: string; maxDepth?: number }) => projects.getTree(options?.path, options?.maxDepth));
  ipcMain.handle('project:context', (_event, options?: { paths?: string[]; maxTokens?: number }) => projects.getContext(options?.paths, options?.maxTokens));
  ipcMain.handle('projects:list', () => {
    const activeRoot = projects.getRoot();
    return projectStorage.list().map((project) => ({ ...project, displayRoot: displayPath(project.root), active: project.root === activeRoot }));
  });
  ipcMain.handle('projects:open', (_event, id: unknown) => {
    const project = projectStorage.get(requireString(id, '项目 ID', 100));
    if (!project) throw new Error('项目记录不存在，请刷新列表');
    return openProjectRoot(project.root);
  });
  ipcMain.handle('projects:remove', (_event, id: unknown) => {
    const project = projectStorage.get(requireString(id, '项目 ID', 100));
    if (!project) return { success: false };
    if (projects.getRoot() === project.root) projects.clear();
    return { success: projectStorage.remove(project.id) };
  });
  ipcMain.handle('projects:pick-directory', async () => {
    const options: OpenDialogOptions = { title: '选择要绑定的项目文件夹', buttonLabel: '选择', properties: ['openDirectory', 'createDirectory'] };
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return undefined;
    const info = describeProject(selected.filePaths[0]);
    pickedProjectRoots.add(info.root);
    return { ...info, existing: Boolean(info.id) };
  });
  ipcMain.handle('projects:create', (_event, input: unknown) => {
    const { root, name } = (input ?? {}) as { root?: unknown; name?: unknown };
    const resolved = resolveExistingRoot(root);
    if (!pickedProjectRoots.has(resolved) && !projectStorage.getByRoot(resolved)) throw new Error('请通过文件夹选择对话框选择项目目录');
    return openProjectRoot(resolved, normalizeProjectName(name));
  });
  ipcMain.handle('growth:profiles', () => growth.getProfiles());
  ipcMain.handle('growth:feedback', (_event, feedback: RoutingFeedback) => growth.recordFeedback(feedback));
  ipcMain.handle('tty:list', () => tty.listSessions());
  ipcMain.handle('tty:create', async (_event, options?: { id?: string; cwd?: string; shell?: string; cols?: number; rows?: number }) => {
    const info = await tty.createSession(options);
    const unsubscribe = tty.onData(info.id, (data) => mainWindow?.webContents.send('tty:data', { sessionId: info.id, data }));
    ttyUnsubscribers.set(info.id, unsubscribe);
    return info;
  });
  ipcMain.handle('tty:write', (_event, id: string, data: string) => tty.write(id, data));
  ipcMain.handle('tty:resize', (_event, id: string, cols: number, rows: number) => tty.resize(id, cols, rows));
  ipcMain.handle('tty:close', (_event, id: string) => { const closed = tty.close(id); ttyUnsubscribers.get(id)?.(); ttyUnsubscribers.delete(id); return closed; });
  ipcMain.handle('execution:run', async (_event, request: CommandExecutionRequest) => {
    const selectedProjectRoot = projects.getRoot();
    if (!selectedProjectRoot) throw new Error('Select a project before running a command');
    // The renderer may display a path for review, but the main process is the
    // authority for the sandbox boundary. Commands always run in the currently
    // selected project and cannot switch roots through IPC payloads.
    const handle = commandExecutor.start({ ...request, projectRoot: selectedProjectRoot });
    const unsubscribe = commandExecutor.onData(handle.id, (event) => mainWindow?.webContents.send('execution:data', { executionId: handle.id, ...event }));
    commandUnsubscribers.set(handle.id, unsubscribe);
    try { return await handle.promise; }
    finally { unsubscribe(); commandUnsubscribers.delete(handle.id); }
  });
  ipcMain.handle('execution:cancel', (_event, id: string) => commandExecutor.cancel(id));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#FFFFFF',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 21 } } : {}),
    webPreferences: { preload: path.join(__dirname, '../preload/preload.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  const keyPath = path.join(app.getPath('userData'), 'credentials.key');
  configureEncryptionKeyProvider(createElectronSafeStorageKeyProvider({ keyPath, safeStorage }));
  storage = new ModelStorage(path.join(app.getPath('userData'), 'amd.db'));
  sessionStorage = new SessionStorage(path.join(app.getPath('userData'), 'sessions.db'));
  projectStorage = new ProjectStorage(path.join(app.getPath('userData'), 'projects.db'));
  registry = new ModelRegistry(storage, { initializePresets: true, persist: true });
  if (!registry.getEnabledModels().length) {
    const firstModel = registry.getAllModels()[0];
    if (firstModel) registry.updateModel(firstModel.id, { enabled: true });
  }
  growth = new GrowthEngine({ storagePath: path.join(app.getPath('userData'), 'growth-profiles.json') });
  router = new AgentRouter(registry, growth);
  tty = new TtyManager({ defaultCwd: app.getPath('documents') });
  projects = new ProjectManager();
  commandExecutor = new CommandExecutor();
  // Pi resources (skills/, extensions/, mcp.json) live in newAi's own data folder, never ~/.pi.
  agentRuntime = new AgentRuntime({ agentDir: path.join(app.getPath('userData'), 'agent'), defaultCwd: app.getPath('documents'), toolGate: approveToolCall, enableMcp: true });
  observability = new ObservabilityEngine(path.join(app.getPath('userData'), 'metrics.db'));
  auditLog = new AuditLog(path.join(app.getPath('userData'), 'audit.jsonl'));
  registerHandlers();
  createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow(); });
}

bootstrap().catch(error => { console.error('AMD Agent failed to start', error); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { for (const controller of runningTasks.values()) controller.abort(); tty?.dispose(); commandExecutor?.dispose(); storage?.close(); sessionStorage?.close(); projectStorage?.close(); observability?.close(); });
