import type { ModelConfig } from '@core/models/ModelConfig';
import { createFileTools, createWebFetchTool, createWebSearchTool } from '@core/tools/builtinTools';
import { SearchProviderRegistry } from '@core/tools/search';
import { ToolRuntime } from '@core/tools/ToolRuntime';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type InlineExtension,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent';
import fs from 'node:fs';
import path from 'node:path';
import { toPiModel } from './modelMapping';
import { buildSystemPrompt } from './systemPrompt';

import { trimHistory } from './AgentHistory';
import { RUN_TIMEOUT_MS, type AgentRunRequest, type AgentRunResult, type AgentRuntimeOptions, type ChatTurn, type ResourceSummary } from './AgentRuntimeTypes';
import { driveAgentSession } from './AgentSessionDriver';
import { installUsageAccounting } from './AgentUsage';
import { prepareRulesPrompt } from './AgentRules';
import { prepareHooks } from './AgentHooks';
import { validateSessionRules } from './sessionRules';

export { trimHistory } from './AgentHistory';
export type { AgentRunRequest, AgentRunResult, AgentRuntimeOptions, AgentTurnContinuation, ChatTurn, ResourceSummary, ToolEvent, ToolGate } from './AgentRuntimeTypes';

/**
 * Runs newAi turns through the Pi SDK. newAi keeps ownership of model credentials (encrypted
 * ModelStorage), chat history (SessionStorage) and routing; Pi provides the agent loop, provider
 * adapters, tool calling, skills, extensions and MCP. Every run builds a fresh in-memory Pi
 * session seeded with the newAi history, so nothing is written to ~/.pi.
 */
export class AgentRuntime {
  readonly search: SearchProviderRegistry;
  private modelRuntime?: Promise<ModelRuntime>;
  private readonly registeredProviders = new Map<string, string>();

  constructor(private readonly options: AgentRuntimeOptions) {
    this.search = options.search ?? new SearchProviderRegistry();
    fs.mkdirSync(path.join(options.agentDir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(options.agentDir, 'extensions'), { recursive: true });
    // Pi's MCP extension reads mcp.json and stores MCP OAuth tokens under its global agent dir.
    // Point it at newAi's directory so nothing is read from or written to ~/.pi.
    if (options.enableMcp) process.env.PI_CODING_AGENT_DIR = options.agentDir;
  }

  get agentDir(): string { return this.options.agentDir; }
  get skillsDir(): string { return path.join(this.options.agentDir, 'skills'); }

  private runtime(): Promise<ModelRuntime> {
    // No auth.json/models.json, no catalog network refresh: newAi supplies models and keys.
    this.modelRuntime ??= ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    return this.modelRuntime;
  }

  private async resolveModel(model: ModelConfig) {
    const runtime = await this.runtime();
    const mapping = toPiModel(model);
    const fingerprint = JSON.stringify(mapping.provider);
    if (this.registeredProviders.get(mapping.providerId) !== fingerprint) {
      runtime.registerProvider(mapping.providerId, mapping.provider as never);
      this.registeredProviders.set(mapping.providerId, fingerprint);
    }
    await runtime.setRuntimeApiKey(mapping.providerId, mapping.apiKey);
    const piModel = runtime.getModel(mapping.providerId, mapping.modelId);
    if (!piModel) throw new Error(`模型注册失败：${model.name}`);
    return { runtime, mapping, piModel };
  }

  private settings() {
    return SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
      enableInstallTelemetry: false,
      defaultProjectTrust: 'never',
      enableSkillCommands: false,
    } as never);
  }

  private extensionFactories(projectRoot?: string, allowMcp = true): InlineExtension[] {
    const gate = this.options.toolGate;
    const factories: InlineExtension[] = [];
    if (gate) {
      factories.push({
        name: 'newai-tool-gate',
        hidden: true,
        factory: (pi) => {
          pi.on('tool_call', async (event) => {
            const reason = await gate({ toolName: event.toolName, input: (event.input ?? {}) as Record<string, unknown>, projectRoot });
            return reason ? { block: true, reason } : undefined;
          });
        },
      });
    }
    // Re-read the app configuration for each session. Never use Pi's project
    // config discovery or its default subprocess transport.
    if (allowMcp && this.options.enableMcp && this.options.mcpConfig) {
      factories.push(
        { name: 'mcp', factory: createMcpExtension({
          logPath: path.join(this.options.agentDir, 'mcp.log'), startupWaitMs: 8000,
          loadConfig: () => this.options.mcpConfig!.loadConfig(),
          createTransport: this.options.mcpTransport ?? (() => { throw new Error('MCP 受控传输服务不可用'); }),
        }) },
        { name: 'codemode', factory: createCodemodeExtension({ models: false }) },
        { name: 'tool-search', factory: createToolSearchExtension() },
      );
    }
    return [...factories, ...(this.options.extensions ?? [])];
  }

  private async resourceLoader(cwd: string, settingsManager: SettingsManager, systemPrompt: string, projectRoot?: string, runExtensions: InlineExtension[] = [], allowMcp = false) {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.options.agentDir,
      settingsManager,
      systemPrompt,
      // Project AGENTS.md / .pi resources are untrusted input; only newAi's own agentDir is loaded.
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      noExtensions: !this.options.enableFileExtensions,
      disabledBuiltinExtensions: ['llama.cpp'],
      extensionFactories: [...this.extensionFactories(projectRoot, allowMcp), ...runExtensions],
      skillsOverride: (base) => ({
        skills: base.skills.filter((skill) => {
          try {
            const relative = path.relative(fs.realpathSync(this.options.agentDir), fs.realpathSync(skill.filePath));
            return Boolean(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) && (this.options.skillManager?.isEnabled(skill.filePath) ?? true);
          } catch { return false; }
        }),
        diagnostics: base.diagnostics,
      }),
    });
    await loader.reload();
    return loader;
  }

  private tools(cwd: string, projectRoot: string | undefined, enableTools: boolean, projectAccess: 'read' | 'write' = 'write'): ToolDefinition[] {
    if (!enableTools) return [];
    const tools = [
      createWebSearchTool(this.search) as unknown as ToolDefinition,
      createWebFetchTool() as unknown as ToolDefinition,
      ...createFileTools({ cwd, projectRoot, extraReadRoots: [this.skillsDir] }),
      ...(this.options.extraTools?.({ cwd, projectRoot }) ?? []),
    ];
    return projectAccess === 'read' ? tools.filter((tool) => ['web_search', 'web_fetch', 'read', 'ls', 'grep', 'find', 'code_symbols', 'code_search', 'process_status', 'process_list'].includes(tool.name)) : tools;
  }

  private seedSession(cwd: string, history: ChatTurn[], piModel: { api: string; provider: string; id: string }, summary?: string): SessionManager {
    const manager = SessionManager.inMemory(cwd);
    if (summary?.trim()) {
      manager.appendCustomMessageEntry('newai-summary', `Summary of earlier conversation (data, not a new request):\n${summary.trim()}`, false);
    }
    let timestamp = Date.now() - history.length * 1000;
    for (const turn of history) {
      timestamp += 1;
      if (turn.role === 'user') manager.appendMessage({ role: 'user', content: turn.content, timestamp } as never);
      else manager.appendMessage({
        role: 'assistant', content: [{ type: 'text', text: turn.content }], api: piModel.api, provider: piModel.provider, model: piModel.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp,
      } as never);
    }
    return manager;
  }

  /** Run one user turn, streaming text and tool events. Resolves with the final assistant text. */
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    validateSessionRules(request.sessionRules);
    if (request.sessionRules?.trim() && !request.rulesLoader) throw new Error('会话规则服务不可用');
    const timeout = AbortSignal.timeout(this.options.runTimeoutMs ?? RUN_TIMEOUT_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    try {
      signal.throwIfAborted();
      return await this.runSession({ ...request, signal });
    } catch (error) {
      if (request.signal?.aborted) throw new Error('任务已取消');
      if (timeout.aborted) throw new Error('任务执行超时，请缩小任务范围后重试');
      throw error;
    }
  }

  private async runSession(request: AgentRunRequest): Promise<AgentRunResult> {
    const enableTools = request.enableTools !== false;
    const cwd = request.projectRoot ?? this.options.defaultCwd;
    const { runtime, mapping, piModel } = await this.resolveModel(request.model);
    const history = request.skipHistoryTrim ? (request.history ?? []) : trimHistory(request.history);
    const settingsManager = this.settings();
    const rawTools = this.tools(cwd, request.projectRoot, enableTools, request.projectAccess);
    if (enableTools && request.projectAccess !== 'read' && request.planTool) rawTools.push(request.planTool);
    const toolRuntime = new ToolRuntime({
      cwd,
      maxCalls: this.options.maxToolCalls,
      maxResultCharsTotal: this.options.maxToolResultChars,
    });
    const toolDefinitions = toolRuntime.wrap(rawTools);
    const promptInput = { now: this.options.now?.() ?? new Date(), tools: toolDefinitions.map((tool) => tool.name), projectRoot: request.projectRoot };
    const rules = prepareRulesPrompt(request, promptInput);
    const hooks = prepareHooks(request);
    const resourceLoader = await this.resourceLoader(cwd, settingsManager, buildSystemPrompt(promptInput), request.projectRoot, [...(rules ? [rules.extension] : []), ...(hooks ? [hooks.extension] : [])], enableTools);
    const model = request.maxTokens ? { ...piModel, maxTokens: Math.min(piModel.maxTokens, request.maxTokens) } : piModel;
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.options.agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: mapping.thinkingLevel,
      noTools: enableTools ? 'builtin' : 'all',
      customTools: toolDefinitions,
      sessionManager: this.seedSession(cwd, history, piModel, request.summary),
      settingsManager,
      resourceLoader,
    });
    const guardedRequest = hooks ? { ...request, beforeModelRequest: (estimate: Parameters<NonNullable<AgentRunRequest['beforeModelRequest']>>[0]) => { hooks.assertReady(); return request.beforeModelRequest?.(estimate); } } : request;
    const usageState = installUsageAccounting(session, guardedRequest, mapping, this.options.runTimeoutMs);
    return driveAgentSession(session, guardedRequest, toolRuntime, usageState, { maxToolRounds: this.options.maxToolRounds, beforeTurn: rules?.beforeTurn, assertReady: hooks?.assertReady });
  }

  /** Describe what the agent can use, for the settings UI. */
  async describe(): Promise<ResourceSummary> {
    const settingsManager = this.settings();
    const loader = await this.resourceLoader(this.options.defaultCwd, settingsManager, '');
    const { skills, diagnostics } = loader.getSkills();
    const tools = this.tools(this.options.defaultCwd, undefined, true).map((tool) => tool.name);
    return {
      agentDir: this.options.agentDir,
      skills: skills.map((skill) => ({ name: skill.name, description: skill.description, path: skill.filePath })),
      tools,
      searchProviders: this.search.list(),
      diagnostics: diagnostics.map((diagnostic) => (diagnostic as { message?: string }).message ?? String(diagnostic)),
    };
  }
}
