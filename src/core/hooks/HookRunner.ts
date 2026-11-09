import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import picomatch from 'picomatch';
import { resolveAllowedPath } from '@core/tools/projectPaths';
import { awaitWithSignal } from '@core/tools/awaitWithSignal';
import { BudgetExceededError } from '@core/routing/RunBudget';
import type { LoadedHook, HookPhase } from './HookConfig';

const { quote } = createRequire(import.meta.url)('shell-quote') as { quote(values: string[]): string };
export interface HookExecution { exitCode: number | null; output: string; sandbox?: unknown; policy?: unknown }
export interface HookStart { invocationId: string; id: string; key: string; phase: HookPhase; source: string; command?: string }
export interface HookResult extends HookStart { status: 'passed' | 'failed' | 'blocked' | 'disabled' | 'cancelled'; durationMs: number; output: string; exitCode?: number | null; sandbox?: unknown; policy?: unknown; reason?: string }
export interface HookInvocation { toolName?: string; files?: string[]; signal?: AbortSignal }
export interface HookRunnerOptions {
  projectRoot: string;
  hooks: LoadedHook[];
  execute(request: { command: string; timeoutMs: number; signal: AbortSignal; hook: LoadedHook; shell?: 'powershell' }): Promise<HookExecution>;
  onStart?(hook: HookStart): void;
  onResult?(result: HookResult): void;
}

function outputTail(text: string): string {
  const buffer = Buffer.from(text);
  return buffer.length <= 4096 ? text : '[Hook 输出已截断]\n' + buffer.subarray(buffer.length - 4096).toString('utf8').replace(/^\uFFFD+/, '');
}

/** A runner belongs to one run: failure counters and the two-process gate never leak to another. */
export class HookRunner {
  private active = 0;
  private readonly pending: Array<() => void> = [];
  private readonly failures = new Map<string, number>();
  constructor(private readonly options: HookRunnerOptions) {
    this.options = { ...options, projectRoot: fs.realpathSync(options.projectRoot) };
  }

  async run(phase: HookPhase, input: HookInvocation = {}): Promise<{ blocked?: string; report: string; results: HookResult[] }> {
    input.signal?.throwIfAborted();
    const files = [...new Set((input.files ?? []).flatMap((file) => {
      try { return [resolveAllowedPath([this.options.projectRoot], file)]; }
      catch { return []; } // Installed skill reads have their own root and are outside project Hooks.
    }))];
    const matching = this.options.hooks.filter((hook) => {
      if (hook.enabled === false || hook.event !== phase) return false;
      if (hook.match?.tool && (!input.toolName || !hook.match.tool.includes(input.toolName))) return false;
      return !hook.match?.glob || files.some((file) => picomatch.isMatch(path.relative(this.options.projectRoot, file).split(path.sep).join('/'), hook.match!.glob!, { dot: true }));
    });
    const settled = await Promise.allSettled(matching.map((hook) => this.invoke(hook, phase, files, input.signal)));
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    const results = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const blocked = phase === 'pre_tool' ? results.find((result) => ['blocked', 'failed'].includes(result.status)) : undefined;
    const report = results.filter((result, index) => result.status === 'failed' && matching[index].onFailure !== 'ignore').map((result) => 'Hook ' + result.id + ' 失败：' + (result.reason || result.output || '命令未成功')).join('\n');
    return { ...(blocked ? { blocked: blocked.reason || blocked.output || ('Hook ' + blocked.id + ' 已阻止工具调用') } : {}), report, results };
  }

  private async invoke(hook: LoadedHook, phase: HookPhase, files: string[], signal?: AbortSignal): Promise<HookResult> {
    const startedAt = Date.now();
    const base = { invocationId: randomUUID(), id: hook.id, key: hook.key, phase, source: hook.source };
    try { this.options.onStart?.({ ...base, command: hook.run }); } catch { /* Telemetry cannot change Hook execution. */ }
    const finish = (result: Omit<HookResult, keyof typeof base | 'durationMs'>): HookResult => {
      const complete = { ...base, ...result, durationMs: Date.now() - startedAt };
      try { this.options.onResult?.(complete); } catch { /* Telemetry cannot change Hook execution. */ }
      return complete;
    };
    if ((this.failures.get(hook.key) ?? 0) >= 3) return finish({ status: 'disabled', output: '', reason: 'Hook 连续失败 3 次，已在本轮停用：' + hook.id });
    if (hook.action === 'block') return finish({ status: 'blocked', output: '', reason: hook.reason });
    let acquired = false;
    let command = hook.run!;
    try {
      await this.acquire(signal); acquired = true;
      signal?.throwIfAborted();
      if ((this.failures.get(hook.key) ?? 0) >= 3) return finish({ status: 'disabled', output: '', reason: 'Hook 连续失败 3 次，已在本轮停用：' + hook.id });
      if (command.includes('{{files}}') && !files.length) throw new Error('Hook 文件占位符没有可用文件');
      const windows = process.platform === 'win32';
      const fileWords = windows ? files.map((file) => "'" + file.replaceAll("'", "''") + "'").join(' ') : quote(files);
      command = command.replaceAll('{{files}}', fileWords);
      if (command.length > 8192) throw new Error('Hook 展开后的命令超过 8192 字符');
      const timeoutMs = hook.timeoutMs ?? 15000;
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const execution = await awaitWithSignal(this.options.execute({ command, timeoutMs, signal: combined, hook, ...(windows ? { shell: 'powershell' as const } : {}) }), combined);
      combined.throwIfAborted();
      const passed = execution.exitCode === 0;
      this.failures.set(hook.key, passed ? 0 : (this.failures.get(hook.key) ?? 0) + 1);
      return finish({ ...execution, command, status: passed ? 'passed' : 'failed', output: outputTail(execution.output) });
    } catch (error) {
      if (!signal?.aborted && !(error instanceof BudgetExceededError)) this.failures.set(hook.key, (this.failures.get(hook.key) ?? 0) + 1);
      const result = finish({ command, status: signal?.aborted ? 'cancelled' : 'failed', output: '', reason: error instanceof Error ? error.message : String(error) });
      if (signal?.aborted) throw signal.reason;
      if (error instanceof BudgetExceededError) throw error;
      return result;
    } finally { if (acquired) { this.active -= 1; this.pending.shift()?.(); } }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < 2) { this.active += 1; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const abort = () => { const index = this.pending.indexOf(ready); if (index >= 0) this.pending.splice(index, 1); reject(signal?.reason ?? new Error('Hook 已取消')); };
      const ready = () => { signal?.removeEventListener('abort', abort); if (signal?.aborted) { this.pending.shift()?.(); reject(signal.reason); } else { this.active += 1; resolve(); } };
      this.pending.push(ready);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}
