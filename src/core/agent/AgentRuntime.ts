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
import { ToolRuntime } from '@core/tools/ToolRuntime';
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
  /** Maximum turns that execute tools before a final text-only summary. Default 32. */
  maxToolRounds?: number;
  /** Maximum tool invocations in one run. Default 80. */
  maxToolCalls?: number;
  /** Maximum model-facing tool output characters in one run. Default 320k. */
  maxToolResultChars?: number;
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
const MAX_TOOL_ROUNDS = 32;

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
    return projectAccess === 'read' ? tools.filter((tool) => ['web_search', 'web_fetch', 'read', 'ls', 'process_status', 'process_list'].includes(tool.name)) : tools;
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
    const rawTools = this.tools(cwd, request.projectRoot, enableTools, request.projectAccess);
    const toolRuntime = new ToolRuntime({
      cwd,
      maxCalls: this.options.maxToolCalls,
      maxResultCharsTotal: this.options.maxToolResultChars,
    });
    const toolDefinitions = toolRuntime.wrap(rawTools);
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
    return this.drive(session, request, toolRuntime);
  }

  private async drive(session: AgentSession, request: AgentRunRequest, toolRuntime: ToolRuntime): Promise<AgentRunResult> {
    let content = '';
    let toolCalls = 0;
    let toolRounds = 0;
    let toolLimitReached = false;
    let summaryCompleted = false;
    let limitDescription = '';
    const toolLabels = new Map<string, string>();
    const completedTools: string[] = [];
    const maxToolRounds = Math.max(1, this.options.maxToolRounds ?? MAX_TOOL_ROUNDS);
    const finishTurn = session.agent.finishTurn;
    const beforeToolCall = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (call, signal) => {
      if (toolLimitReached) return { block: true, reason: '工具额度已用尽，请只基于现有结果生成阶段性总结。', terminate: true };
      return beforeToolCall?.(call, signal);
    };
    // Keep the accumulated tool results and reserve one logical answer turn.
    // This does not reset tool counts or the existing run deadline.
    session.agent.finishTurn = async (turn, signal) => {
      const decision = await finishTurn?.(turn, signal);
      if (signal?.aborted || request.signal?.aborted || turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') return { action: 'end' };
      if (toolLimitReached) {
        summaryCompleted = !turn.toolResults.length && Boolean(textOf(turn.message).trim());
        return { action: 'end' };
      }
      if (decision?.action === 'end') return decision;
      if (turn.toolResults.length) toolRounds += 1;
      const budget = toolRuntime.getBudgetState();
      if (turn.toolResults.length && (toolRounds >= maxToolRounds || toolCalls >= budget.maxCalls || budget.exhaustedBy)) {
        toolLimitReached = true;
        limitDescription = toolRounds >= maxToolRounds ? `${maxToolRounds} 轮工具调用`
          : budget.exhaustedBy === 'output' ? `${budget.maxResultChars} 字符工具结果` : `${budget.maxCalls} 次工具调用`;
        session.setActiveToolsByName([]);
        session.setAutoRetryEnabled(false);
        await session.sendCustomMessage({
          customType: 'newai-tool-budget-summary', display: false,
          content: `本轮工具额度已用尽（${limitDescription}），工具现已关闭。请立即根据本轮已经获取的资料，用用户的语言给出阶段性分析。明确列出已确认的结论、已检查的文件或范围、仍未验证或未完成的事项，以及下一步最值得继续的内容。不要再次请求工具，不要只说“继续读取”，不要把未完成的项目分析称为已全部完成。如果资料不足，说明具体缺少什么，不要编造结论。`,
        }, { deliverAs: 'steer' });
        return { action: 'continue' };
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
        if (toolLimitReached) return;
        toolCalls += 1;
        const args = event.args as { path?: unknown; query?: unknown } | undefined;
        const label = typeof args?.path === 'string' ? args.path : typeof args?.query === 'string' ? args.query : '';
        toolLabels.set(event.toolCallId, `${event.toolName}${label ? `：${label.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
        request.onToolEvent?.({ toolCallId: event.toolCallId, toolName: event.toolName, status: 'running', args: event.args });
      } else if (event.type === 'tool_execution_end') {
        if (toolLimitReached) return;
        if (!event.isError) completedTools.push(toolLabels.get(event.toolCallId) ?? event.toolName);
        toolLabels.delete(event.toolCallId);
        request.onToolEvent?.({ toolCallId: event.toolCallId, toolName: event.toolName, status: event.isError ? 'failed' : 'completed', summary: summarizeToolResult(event.result), details: (event.result as { details?: unknown })?.details, durationMs: event.durationMs });
      }
    });
    try {
      await session.bindExtensions({ mode: 'print' });
      if (request.signal?.aborted) throw new Error('任务已取消');
      let summaryFailed = false;
      try { await session.prompt(request.prompt, { expandPromptTemplates: false }); }
      catch (error) {
        if (!toolLimitReached || request.signal?.aborted) throw error;
        summaryFailed = true;
      }
      const stats = session.getSessionStats();
      const last = [...session.messages].reverse().find((message) => (message as { role?: string }).role === 'assistant') as { stopReason?: string; errorMessage?: string } | undefined;
      if (last?.stopReason === 'error' && !toolLimitReached) throw new Error(last.errorMessage || '模型调用失败');
      if (last?.stopReason === 'aborted' || request.signal?.aborted) throw new Error('任务已取消');
      const finalText = session.getLastAssistantText() ?? '';
      let answer = finalText.trim() ? finalText : content;
      if (toolLimitReached && (!summaryCompleted || summaryFailed || last?.stopReason === 'error')) {
        answer = `工具额度已用尽（${limitDescription}）。阶段总结未能生成，本轮分析尚未完成。\n\n`
          + (completedTools.length ? `已完成 ${completedTools.length} 次工具操作，最近的操作包括：\n${completedTools.slice(-12).map((label) => `- ${label}`).join('\n')}` : '本轮没有获得可用的工具结果。')
          + '\n\n继续任务时可从上述已检查范围接着分析。';
        request.onTextDelta?.(`${content.trim() ? '\n\n' : ''}${answer}`);
      }
      if (!answer.trim()) throw new Error('模型返回空文本，未生成可用回答');
      return {
        content: answer,
        inputTokens: stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite,
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
