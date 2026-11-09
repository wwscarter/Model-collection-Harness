import fs from 'node:fs';
import path from 'node:path';
import { containsSensitiveContent } from '@core/security/sensitiveContent';
import { atomicRuleWrite, MAX_RULE_BYTES, MAX_RULE_FILES, readRuleText, regularRulePath, ruleId, ruleNames } from './RuleFiles';
import type { RuleEntry } from './RuleTypes';

interface RulesState { enabled: Record<string, boolean>; valid: boolean; diagnostics: string[] }
export interface GlobalRuleInput { name: string; content: string; enabled?: boolean }

/** Global mutations accept rule IDs only; file paths are derived under the app agent directory. */
export class GlobalRulesStore {
  readonly agentDir: string;
  private readonly statePath: string;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(agentDir: string) {
    fs.mkdirSync(agentDir, { recursive: true });
    this.agentDir = fs.realpathSync(agentDir);
    this.statePath = path.join(this.agentDir, 'rules-state.json');
  }

  async list(signal?: AbortSignal): Promise<{ rules: RuleEntry[]; diagnostics: string[]; truncated: boolean }> {
    const state = this.readState();
    const diagnostics = [...state.diagnostics];
    let found;
    try { found = await ruleNames(this.agentDir, 'rules', signal); }
    catch (error) { signal?.throwIfAborted(); return { rules: [], diagnostics: [...diagnostics, '全局规则目录无法读取：' + this.message(error)], truncated: true }; }
    const rules: RuleEntry[] = [];
    for (const name of found.names) {
      signal?.throwIfAborted();
      try {
        const id = ruleId(name);
        const file = regularRulePath(this.agentDir, path.join('rules', name));
        const text = await readRuleText(file, signal);
        if (!text) continue;
        const blocked = containsSensitiveContent(text.content) ? '规则可能包含密钥或令牌，已拒绝加载' : undefined;
        rules.push({ id, name: id, source: 'global', path: file, content: blocked ? '' : text.content, hash: text.hash, enabled: state.valid && state.enabled[id] !== false, trusted: true, ...(blocked ? { blocked } : {}) });
        if (blocked) diagnostics.push(name + '：' + blocked);
      } catch (error) { signal?.throwIfAborted(); diagnostics.push(name + '：' + this.message(error)); }
    }
    if (found.truncated) diagnostics.push('全局规则文件超过 64 条，列表已截断');
    return { rules, diagnostics, truncated: found.truncated };
  }

  saveGlobal(input: GlobalRuleInput): Promise<RuleEntry> { return this.mutate(() => this.writeGlobal(input)); }
  setEnabled(name: string, enabled: boolean): Promise<RuleEntry> { return this.mutate(() => this.writeEnabled(name, enabled)); }
  removeGlobal(name: string): Promise<boolean> { return this.mutate(() => this.deleteGlobal(name)); }

  private async writeGlobal(input: GlobalRuleInput): Promise<RuleEntry> {
    const id = ruleId(input?.name);
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > MAX_RULE_BYTES) throw new Error('单条规则内容不能超过 256KB');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('规则启用状态无效');
    if (containsSensitiveContent(input.content)) throw new Error('规则可能包含密钥或令牌，已拒绝保存');
    const file = regularRulePath(this.agentDir, path.join('rules', id + '.md'));
    const previous = await readRuleText(file);
    const found = await ruleNames(this.agentDir, 'rules');
    if (!previous && (found.truncated || found.names.length >= MAX_RULE_FILES)) throw new Error('全局规则最多 64 条');
    const state = await this.writableState();
    const enabled = input.enabled ?? (state[id] !== false);
    atomicRuleWrite(file, input.content);
    try { this.saveState({ ...state, [id]: enabled }); }
    catch (error) { if (previous) atomicRuleWrite(file, previous.content); else fs.rmSync(file, { force: true }); throw error; }
    const saved = await readRuleText(file);
    if (!saved) throw new Error('已保存的规则无法读取');
    return { id, name: id, source: 'global', path: file, ...saved, enabled, trusted: true };
  }

  private async writeEnabled(name: string, enabled: boolean): Promise<RuleEntry> {
    const id = ruleId(name);
    if (typeof enabled !== 'boolean') throw new Error('规则启用状态无效');
    const file = regularRulePath(this.agentDir, path.join('rules', id + '.md'));
    const text = await readRuleText(file);
    if (!text) throw new Error('规则不存在');
    if (enabled && containsSensitiveContent(text.content)) throw new Error('规则可能包含密钥或令牌，已拒绝启用');
    this.saveState({ ...await this.writableState(), [id]: enabled });
    const blocked = containsSensitiveContent(text.content) ? '规则可能包含密钥或令牌，已拒绝加载' : undefined;
    return { id, name: id, source: 'global', path: file, content: blocked ? '' : text.content, hash: text.hash, enabled, trusted: true, ...(blocked ? { blocked } : {}) };
  }

  private async deleteGlobal(name: string): Promise<boolean> {
    const id = ruleId(name);
    const file = regularRulePath(this.agentDir, path.join('rules', id + '.md'));
    const previous = await readRuleText(file);
    if (!previous) return false;
    const state = await this.writableState(); delete state[id];
    fs.unlinkSync(file);
    try { this.saveState(state); } catch (error) { atomicRuleWrite(file, previous.content); throw error; }
    return true;
  }

  private readState(): RulesState {
    try {
      regularRulePath(this.agentDir, 'rules-state.json');
      if (fs.statSync(this.statePath).size > 256 * 1024) throw new Error('启用状态文件过大');
      const value = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as { version?: unknown; enabled?: unknown };
      if (value.version !== 1 || !value.enabled || typeof value.enabled !== 'object' || Array.isArray(value.enabled)) throw new Error('启用状态格式无效');
      const enabled: Record<string, boolean> = {};
      for (const [id, active] of Object.entries(value.enabled)) {
        if (ruleId(id) !== id || typeof active !== 'boolean') throw new Error('启用状态格式无效');
        enabled[id] = active;
      }
      return { enabled, valid: true, diagnostics: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: {}, valid: true, diagnostics: [] };
      return { enabled: {}, valid: false, diagnostics: ['全局规则启用状态读取失败，已停用全局规则'] };
    }
  }

  private async writableState(): Promise<Record<string, boolean>> {
    const state = this.readState();
    if (state.valid) return state.enabled;
    const found = await ruleNames(this.agentDir, 'rules');
    return Object.fromEntries(found.names.flatMap((name) => { try { return [[ruleId(name), false]]; } catch { return []; } }));
  }
  private saveState(enabled: Record<string, boolean>): void {
    regularRulePath(this.agentDir, 'rules-state.json');
    const content = JSON.stringify({ version: 1, enabled }, null, 2) + '\n';
    if (Buffer.byteLength(content, 'utf8') > 256 * 1024) throw new Error('规则启用状态超过容量上限');
    atomicRuleWrite(this.statePath, content);
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const work = this.mutation.then(action);
    this.mutation = work.then(() => undefined, () => undefined);
    return work;
  }
  private message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
