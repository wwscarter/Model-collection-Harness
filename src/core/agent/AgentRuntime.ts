import fs from 'node:fs';
import path from 'node:path';
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type InlineExtension,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { ModelConfig } from '@core/models/ModelConfig';
import { toPiModel } from './modelMapping';
import { buildSystemPrompt } from './systemPrompt';
import { createFileTools, createWebFetchTool, createWebSearchTool } from '@core/tools/builtinTools';
import { SearchProviderRegistry } from '@core/tools/search';

export interface ChatTurn { role: 'user' | 'assistant'; content: string; }

export interface ToolEvent {
  toolCallId: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  args?: unknown;
  summary?: string;
  details?: unknown;
  durationMs?: number;
}

export interface AgentRunRequest {
  model: ModelConfig;
  prompt: string;
  history?: ChatTurn[];
  /** Hidden summary of older turns, injected as a non-displayed custom message. */
  summary?: string;
  /** The caller already applied its token budget; skip the 20-turn/60k-char trim. */
  skipHistoryTrim?: boolean;
  projectRoot?: string;
  /** Analysis subagents can inspect a project without modifying it or running commands. */
  projectAccess?: 'read' | 'write';
  /** Allow web_search / web_fetch / file tools. False sends a plain chat request. */
  enableTools?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onToolEvent?: (event: ToolEvent) => void;
}

export interface AgentRunResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  stopReason: string;
}

/** Decide whether a tool call may run. Returning a string blocks it with that reason. */
export type ToolGate = (call: { toolName: string; input: Record<string, unknown>; projectRoot?: string }) => Promise<string | undefined> | string | undefined;

export interface AgentRuntimeOptions {
  /** Directory owned by newAi for Pi resources: skills/, extensions/, mcp.json. Never ~/.pi. */
  agentDir: string;
  /** Working directory used when no project is selected. */
  defaultCwd: string;
  search?: SearchProviderRegistry;
  /** Extra tools contributed by plugins. */
  extraTools?: (context: { cwd: string; projectRoot?: string }) => ToolDefinition[];
  /** Extra Pi extensions (inline factories). */
  extensions?: InlineExtension[];
  toolGate?: ToolGate;
  /** Load agentDir/mcp.json servers through Pi's MCP extension. */
  enableMcp?: boolean;
  /** Load agentDir/extensions/* code. Off by default: extensions run with full app permissions. */
  enableFileExtensions?: boolean;
  /** Maximum duration of a run, including model requests and tools. Default five minutes. */
  runTimeoutMs?: number;
  /** Maximum consecutive turns that execute tools. Default eight. */
  maxToolRounds?: number;
  /** Test seam. */
  now?: () => Date;
}

export interface ResourceSummary {
  agentDir: string;
  skills: Array<{ name: string; description: string; path: string }>;
  tools: string[];
  searchProviders: Array<{ id: string; label: string; active: boolean }>;
  diagnostics: string[];
}

const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 60_000;
const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_TOOL_ROUNDS = 8;

/** Keep the newest turns that fit the budget; always start the window on a user turn. */
export function trimHistory(history: ChatTurn[] = [], maxTurns = MAX_HISTORY_TURNS, maxChars = MAX_HISTORY_CHARS): ChatTurn[] {
  const clean = history.filter((turn) => (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string' && turn.content.trim());
  const kept: ChatTurn[] = [];
  let chars = 0;
  for (let index = clean.length - 1; index >= 0 && kept.length < maxTurns; index -= 1) {
    chars += clean[index].content.length;
    if (chars > maxChars) break;
    kept.unshift(clean[index]);
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

function textOf(message: { content?: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part: { type?: string; text?: string }) => part?.type === 'text' ? part.text ?? '' : '').join('');
}

function summarizeToolResult(result: unknown): string | undefined {
  const text = textOf((result ?? {}) as { content?: unknown }).trim();
  return text ? text.slice(0, 280) : undefined;
}

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

  private extensionFactories(projectRoot?: string): InlineExtension[] {
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
    // MCP servers (agentDir/mcp.json) reconnect at every session start, so only load the extension
    // when servers are configured. MCP tools default to `codemode` exposure, which needs codemode.
    if (this.options.enableMcp && fs.existsSync(path.join(this.options.agentDir, 'mcp.json'))) {
      factories.push(
        { name: 'mcp', factory: createMcpExtension({ logPath: path.join(this.options.agentDir, 'mcp.log'), startupWaitMs: 8000 }) },
        { name: 'codemode', factory: createCodemodeExtension({ models: false }) },
        { name: 'tool-search', factory: createToolSearchExtension() },
      );
    }
    return [...factories, ...(this.options.extensions ?? [])];
  }

  private async resourceLoader(cwd: string, settingsManager: SettingsManager, systemPrompt: string, projectRoot?: string) {
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
      extensionFactories: this.extensionFactories(projectRoot),
      skillsOverride: (base) => ({
        skills: base.skills.filter((skill) => skill.filePath.startsWith(this.options.agentDir)),
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
    return projectAccess === 'read' ? tools.filter((tool) => ['web_search', 'web_fetch', 'read', 'ls'].includes(tool.name)) : tools;
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
    const toolDefinitions = this.tools(cwd, request.projectRoot, enableTools, request.projectAccess);
    const systemPrompt = buildSystemPrompt({ now: this.options.now?.() ?? new Date(), tools: toolDefinitions.map((tool) => tool.name), projectRoot: request.projectRoot });
    const resourceLoader = await this.resourceLoader(cwd, settingsManager, systemPrompt, request.projectRoot);
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
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (requestModel, context, options) => stream(requestModel, context, {
      ...options,
      ...(mapping.temperature !== undefined ? { temperature: mapping.temperature } : {}),
      timeoutMs: Math.min(options?.timeoutMs ?? RUN_TIMEOUT_MS, this.options.runTimeoutMs ?? RUN_TIMEOUT_MS),
    });
    return this.drive(session, request);
  }

  private async drive(session: AgentSession, request: AgentRunRequest): Promise<AgentRunResult> {
    let content = '';
    let toolCalls = 0;
    let toolRounds = 0;
    let toolLimitReached = false;
    const maxToolRounds = Math.max(1, this.options.maxToolRounds ?? MAX_TOOL_ROUNDS);
    const finishTurn = session.agent.finishTurn;
    // Pi's finishTurn hook stops before another provider request while retaining tool results.
    session.agent.finishTurn = async (turn, signal) => {
      const decision = await finishTurn?.(turn, signal);
      if (turn.toolResults.length && ++toolRounds >= maxToolRounds) {
        toolLimitReached = true;
        return { action: 'end' };
      }
      return decision || undefined;
    };
    const onAbort = () => { void session.abort(); };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        content += event.assistantMessageEvent.delta;
        request.onTextDelta?.(event.assistantMessageEvent.delta);
      } else if (event.type === 'message_start' && (event.message as { role?: string }).role === 'assistant' && content && !content.endsWith('\n')) {
        // A new assistant message after tool calls: keep paragraphs apart in the streamed text.
        content += '\n\n';
        request.onTextDelta?.('\n\n');
      } else if (event.type === 'tool_execution_start') {
        toolCalls += 1;
        request.onToolEvent?.({ toolCallId: event.toolCallId, toolName: event.toolName, status: 'running', args: event.args });
      } else if (event.type === 'tool_execution_end') {
        request.onToolEvent?.({ toolCallId: event.toolCallId, toolName: event.toolName, status: event.isError ? 'failed' : 'completed', summary: summarizeToolResult(event.result), details: (event.result as { details?: unknown })?.details, durationMs: event.durationMs });
      }
    });
    try {
      await session.bindExtensions({ mode: 'print' });
      if (request.signal?.aborted) throw new Error('任务已取消');
      await session.prompt(request.prompt, { expandPromptTemplates: false });
      const stats = session.getSessionStats();
      const last = [...session.messages].reverse().find((message) => (message as { role?: string }).role === 'assistant') as { stopReason?: string; errorMessage?: string } | undefined;
      if (last?.stopReason === 'error') throw new Error(last.errorMessage || '模型调用失败');
      if (last?.stopReason === 'aborted' || request.signal?.aborted) throw new Error('任务已取消');
      const finalText = session.getLastAssistantText() ?? '';
      if (toolLimitReached) {
        const notice = `${content.trim() || finalText.trim() ? '\n\n' : ''}已达到本轮工具调用上限（${maxToolRounds} 轮），任务已停止。请缩小范围后继续。`;
        content = (content.trim() ? content : finalText) + notice;
        request.onTextDelta?.(notice);
      }
      return {
        content: content.trim() ? content : finalText,
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        toolCalls,
        stopReason: toolLimitReached ? 'tool_limit' : last?.stopReason ?? 'stop',
      };
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      session.dispose();
    }
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
