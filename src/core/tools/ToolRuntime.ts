import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { awaitWithSignal } from './awaitWithSignal';

type ToolExecute = ToolDefinition['execute'];
type ToolResult = Awaited<ReturnType<ToolExecute>>;

export interface ToolPolicy {
  /** Tool name. */
  name: string;
  maxResultChars: number;
  /** Wrapper deadline; omit for tools with their own timeout (run_command). */
  timeoutMs?: number;
  /** Cached only when > 0 and the tool is read-only. */
  cacheTtlMs?: number;
}

const DEFAULT_POLICY: ToolPolicy = { name: '*', maxResultChars: 12_000 };

export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  web_search: { name: 'web_search', maxResultChars: 8_000, timeoutMs: 35_000, cacheTtlMs: 5 * 60_000 },
  web_fetch: { name: 'web_fetch', maxResultChars: 12_000, timeoutMs: 25_000, cacheTtlMs: 10 * 60_000 },
  read: { name: 'read', maxResultChars: 12_000, timeoutMs: 5_000, cacheTtlMs: 30_000 },
  ls: { name: 'ls', maxResultChars: 8_000, timeoutMs: 5_000, cacheTtlMs: 30_000 },
  write: { name: 'write', maxResultChars: 2_000, timeoutMs: 10_000 },
  edit: { name: 'edit', maxResultChars: 2_000, timeoutMs: 10_000 },
  process_status: { name: 'process_status', maxResultChars: 8_000, timeoutMs: 5_000 },
  process_list: { name: 'process_list', maxResultChars: 8_000, timeoutMs: 5_000 },
};

interface CacheEntry { expiresAt: number; result: ToolResult; }

export interface ToolRuntimeOptions {
  cwd: string;
  maxCalls?: number;
  maxResultCharsTotal?: number;
  now?: () => number;
  policies?: Record<string, ToolPolicy>;
}

export interface ToolBudgetState {
  calls: number;
  maxCalls: number;
  resultChars: number;
  maxResultChars: number;
  exhaustedBy?: 'calls' | 'output';
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

/**
 * Per-run tool guard: enforces total call/result budgets, truncates oversized
 * model-facing output, and caches safe read-only tools.
 */
export class ToolRuntime {
  private readonly cwd: string;
  private readonly maxCalls: number;
  private readonly maxResultCharsTotal: number;
  private readonly now: () => number;
  private readonly policies: Record<string, ToolPolicy>;
  private readonly cache = new Map<string, CacheEntry>();
  private calls = 0;
  private resultChars = 0;
  private fileVersion = 0;

  constructor(options: ToolRuntimeOptions) {
    this.cwd = options.cwd;
    this.maxCalls = options.maxCalls ?? 80;
    this.maxResultCharsTotal = options.maxResultCharsTotal ?? 320_000;
    this.now = options.now ?? (() => Date.now());
    this.policies = { ...TOOL_POLICIES, ...(options.policies ?? {}) };
  }

  wrap(tools: ToolDefinition[]): ToolDefinition[] {
    return tools.map((tool) => ({
      ...tool,
      execute: async (...args: Parameters<ToolExecute>): Promise<ToolResult> => this.run(tool, args),
    })) as ToolDefinition[];
  }

  getBudgetState(): ToolBudgetState {
    return {
      calls: this.calls, maxCalls: this.maxCalls, resultChars: this.resultChars, maxResultChars: this.maxResultCharsTotal,
      exhaustedBy: this.calls >= this.maxCalls ? 'calls' : this.resultChars >= this.maxResultCharsTotal ? 'output' : undefined,
    };
  }

  private policy(name: string): ToolPolicy {
    return this.policies[name] ?? DEFAULT_POLICY;
  }

  private async cacheKey(name: string, params: unknown): Promise<string> {
    try {
      if (name === 'read' && params && typeof params === 'object' && typeof (params as { path?: unknown }).path === 'string') {
        const target = path.resolve(this.cwd, (params as { path: string }).path);
        const stat = await fs.promises.stat(target);
        return `read:${this.fileVersion}:${target}:${stat.mtimeMs}:${stat.size}:${stable(params)}`;
      }
      if (name === 'ls') return `ls:${this.fileVersion}:${stable(params)}`;
      return `${name}:${stable(params)}`;
    } catch {
      return '';
    }
  }

  private async run(tool: ToolDefinition, args: Parameters<ToolExecute>): Promise<ToolResult> {
    args[2]?.throwIfAborted();
    if (this.calls >= this.maxCalls) throw new Error(`本轮工具调用次数已达上限（${this.maxCalls} 次），请基于已有结果生成阶段性总结。`);
    if (this.resultChars >= this.maxResultCharsTotal) throw new Error('本轮工具输出额度已用尽，请基于已有结果生成阶段性总结。');
    this.calls += 1;
    const policy = this.policy(tool.name);
    const params = args[1];
    const [toolCallId, callParams, signal, onUpdate, context] = args;
    const timeout = policy.timeoutMs ? AbortSignal.timeout(policy.timeoutMs) : undefined;
    const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
    const key = policy.cacheTtlMs ? await awaitWithSignal(this.cacheKey(tool.name, params), combined) : '';
    if (key) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > this.now()) return this.limit(hit.result, policy);
    }
    const changesFiles = ['write', 'edit', 'run_command'].includes(tool.name);
    if (changesFiles) this.fileVersion += 1;
    let result: ToolResult;
    try {
      result = await awaitWithSignal(tool.execute(toolCallId, callParams, combined, onUpdate, context), combined);
      combined?.throwIfAborted();
    } catch (error) {
      if (timeout?.aborted && !signal?.aborted) throw new Error(`工具 ${tool.name} 执行超时`);
      throw error;
    } finally {
      // Commands may have changed files even when they report failure.
      if (changesFiles) this.fileVersion += 1;
    }
    if (key && !result.isError) {
      this.cache.set(key, { expiresAt: this.now() + (policy.cacheTtlMs ?? 0), result });
      while (this.cache.size > 100) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest); else break;
      }
    }
    return this.limit(result, policy);
  }

  private limit(result: ToolResult, policy: ToolPolicy): ToolResult {
    const remaining = Math.max(0, this.maxResultCharsTotal - this.resultChars);
    const budget = Math.min(policy.maxResultChars, remaining);
    let used = 0;
    let truncated = false;
    const content = result.content.map((part) => {
      if (part.type !== 'text') return part;
      const left = Math.max(0, budget - used);
      const text = String(part.text ?? '');
      if (text.length <= left) { used += text.length; return part; }
      truncated = true;
      const slice = text.slice(0, left);
      used += slice.length;
      return { ...part, text: `${slice}\n\n[结果已截断以控制上下文；原长度 ${text.length} 字符]` };
    });
    this.resultChars += used;
    if (this.resultChars >= this.maxResultCharsTotal && !truncated) {
      content.push({ type: 'text' as const, text: `[本轮工具结果总量已达上限（${this.maxResultCharsTotal} 字符）]` });
    }
    return { ...result, content };
  }
}
