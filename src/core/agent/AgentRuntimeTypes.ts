import type { ModelConfig } from '@core/models/ModelConfig';
import type { ModelRequestEstimate, ModelUsage } from '@core/routing/ModelUsage';
import type { BudgetExceededError } from '@core/routing/RunBudget';
import type { SearchProviderRegistry } from '@core/tools/search';
import type { Usage } from '@earendil-works/pi-ai';
import type { InlineExtension, McpTransportFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { FormattedRules } from './RulePrompt';
import type { RulesLoader } from './RulesLoader';
import type { HookRunner } from '@core/hooks/HookRunner';
import type { SkillManager } from './SkillManager';
import type { McpConfigStore } from './McpConfigStore';

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
  /** Ephemeral system instructions; do not append to history or summaries. */
  sessionRules?: string;
  /** App-owned loader: the renderer never supplies file access or trusted content. */
  rulesLoader?: Pick<RulesLoader, 'load'>;
  onRulesLoaded?: (metadata: Pick<FormattedRules, 'rules' | 'truncated'>) => void;
  hookRunner?: Pick<HookRunner, 'run'>;
  /** Analysis subagents can inspect a project without modifying it or running commands. */
  projectAccess?: 'read' | 'write';
  /** Allow web_search / web_fetch / file tools. False sends a plain chat request. */
  enableTools?: boolean;
  planTool?: ToolDefinition;
  maxTokens?: number;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onToolEvent?: (event: ToolEvent) => void;
  onUsage?: (usage: ModelUsage) => void;
  beforeModelRequest?: (request: ModelRequestEstimate) => { maxOutputTokens: number } | void;
  /** Continue the same Pi session after project checks, preserving tools and usage. */
  afterTurn?: (result: AgentRunResult, context?: { signal?: AbortSignal }) => Promise<AgentTurnContinuation | undefined> | AgentTurnContinuation | undefined;
}

export interface AgentRunResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  stopReason: string;
  budgetLimitReason?: string;
}

export interface RunUsageState {
  usage: Required<ModelUsage>;
  seen: WeakSet<object>;
  budgetError?: BudgetExceededError;
  callbackError?: unknown;
  report(usage: Usage): void;
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
  skillManager?: Pick<SkillManager, 'isEnabled'>;
  /** Only the app configuration loader can supply decrypted runtime credentials. */
  mcpConfig?: Pick<McpConfigStore, 'loadConfig'>;
  /** The host supplies the approved transport, including sandboxed stdio execution. */
  mcpTransport?: McpTransportFactory;
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

export interface AgentTurnContinuation { feedback?: string; summary?: string; stopReason?: 'budget_limit' | 'tool_limit' | 'length'; }
export const RUN_TIMEOUT_MS = 5 * 60_000;
export const MAX_TOOL_ROUNDS = 32;
