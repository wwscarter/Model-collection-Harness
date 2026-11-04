import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

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
  web_search: { name: 'web_search', maxResultChars: 8_000, timeoutMs: 20_000, cacheTtlMs: 5 * 60_000 },
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

  constructor(options: ToolRuntimeOptions) {
    this.cwd = options.cwd;
    this.maxCalls = options.maxCalls ?? 20;
    this.maxResultCharsTotal = options.maxResultCharsTotal ?? 80_000;
    this.now = options.now ?? (() => Date.now());
    this.policies = { ...TOOL_POLICIES, ...(options.policies ?? {}) };
  }

  wrap(tools: ToolDefinition[]): ToolDefinition[] {
    return tools.map((tool) => ({
      ...tool,
      execute: async (...args: Parameters<ToolExecute>): Promise<ToolResult> => this.run(tool, args),
    })) as ToolDefinition[];
  }

  private policy(name: string): ToolPolicy {
    return this.policies[name] ?? DEFAULT_POLICY;
  }

  private cacheKey(name: string, params: unknown): string {
    try {
      if (name === 'read' && params && typeof params === 'object' && typeof (params as { path?: unknown }).path === 'string') {
        const target = path.resolve(this.cwd, (params as { path: string }).path);
        const stat = fs.statSync(target);
        return `read:${target}:${stat.mtimeMs}:${stat.size}`;
      }
      return `${name}:${stable(params)}`;
    } catch {
      return '';
    }
  }

  private async run(tool: ToolDefinition, args: Parameters<ToolExecute>): Promise<ToolResult> {
    if (this.calls >= this.maxCalls) throw new Error(`本轮工具调用次数已达上限（${this.maxCalls} 次），请缩小任务范围。`);
    this.calls += 1;
    const policy = this.policy(tool.name);
    const params = args[1];
    const key = policy.cacheTtlMs ? this.cacheKey(tool.name, params) : '';
    if (key) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > this.now()) return this.limit(hit.result, policy);
    }
    const [toolCallId, callParams, signal, onUpdate, context] = args;
    const timeout = policy.timeoutMs ? AbortSignal.timeout(policy.timeoutMs) : undefined;
    const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
    const result = await tool.execute(toolCallId, callParams, combined, onUpdate, context);
    if (key) {
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
