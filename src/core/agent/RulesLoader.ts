import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { containsSensitiveContent } from '@core/security/sensitiveContent';
import type { TrustStore } from '@core/security/TrustStore';
import { GlobalRulesStore, type GlobalRuleInput } from './GlobalRulesStore';
import { MAX_RULE_BYTES, readRuleText, regularRulePath, ruleId, ruleNames } from './RuleFiles';
import type { RuleEntry, RulesCatalog, RulesInput, RulesLoadResult } from './RuleTypes';
export type { RuleEntry, RuleSource, RulesCatalog, RulesInput, RulesLoadResult } from './RuleTypes';
export type { GlobalRuleInput } from './GlobalRulesStore';

export interface RulesLoaderOptions { agentDir: string; trustStore: TrustStore; maxChars?: number }

/** Project files are listed for human preview; only explicitly trusted bytes reach load(). */
export class RulesLoader {
  readonly global: GlobalRulesStore;
  private readonly maxChars: number;

  constructor(private readonly options: RulesLoaderOptions) {
    this.global = new GlobalRulesStore(options.agentDir);
    this.maxChars = Number.isFinite(options.maxChars) ? Math.max(1, Math.min(8_000, Math.floor(options.maxChars!))) : 8_000;
  }

  async list(input: RulesInput = {}): Promise<RulesCatalog> {
    input.signal?.throwIfAborted();
    if (typeof input.sessionRules === 'string' && Buffer.byteLength(input.sessionRules, 'utf8') > MAX_RULE_BYTES) throw new Error('会话规则不能超过 256KB');
    const global = await this.global.list(input.signal);
    const diagnostics = [...this.options.trustStore.diagnostics, ...global.diagnostics];
    const project: RuleEntry[] = [];
    let truncated = global.truncated;
    if (input.projectRoot) {
      try {
        const root = await fs.promises.realpath(input.projectRoot);
        let names = { names: [] as string[], truncated: false };
        try { names = await ruleNames(root, path.join('.newai', 'rules'), input.signal); }
        catch (error) { input.signal?.throwIfAborted(); diagnostics.push('项目 .newai/rules 目录无法读取：' + this.message(error)); }
        truncated ||= names.truncated;
        if (names.truncated) diagnostics.push('项目规则文件超过 64 条，列表已截断');
        for (const relative of ['AGENTS.md', ...names.names.map((name) => '.newai/rules/' + name)]) {
          input.signal?.throwIfAborted();
          try {
            if (relative !== 'AGENTS.md') ruleId(path.basename(relative));
            const file = regularRulePath(root, relative);
            const text = await readRuleText(file, input.signal);
            if (!text) continue;
            const blocked = containsSensitiveContent(text.content) ? '规则可能包含密钥或令牌，已拒绝加载' : undefined;
            project.push({ id: relative, name: path.basename(relative), source: 'project', path: file, content: blocked ? '' : text.content, hash: text.hash, trusted: this.options.trustStore.isTrusted(root, relative, text.hash), enabled: true, ...(blocked ? { blocked } : {}) });
            if (blocked) diagnostics.push(relative + '：' + blocked);
          } catch (error) { input.signal?.throwIfAborted(); diagnostics.push(relative + '：' + this.message(error)); }
        }
      } catch (error) { input.signal?.throwIfAborted(); diagnostics.push('项目规则读取失败：' + this.message(error)); }
    }
    const session: RuleEntry[] = [];
    if (input.sessionRules !== undefined) {
      if (typeof input.sessionRules !== 'string') diagnostics.push('会话规则必须是文本');
      else if (input.sessionRules.trim()) {
        const blocked = containsSensitiveContent(input.sessionRules) ? '会话规则可能包含密钥或令牌，已拒绝加载' : undefined;
        session.push({ id: 'session', name: '本会话规则', source: 'session', path: '<session>', content: blocked ? '' : input.sessionRules, hash: createHash('sha256').update(input.sessionRules).digest('hex'), trusted: true, enabled: true, ...(blocked ? { blocked } : {}) });
        if (blocked) diagnostics.push(blocked);
      }
    }
    return { global: global.rules, project, session, rules: [...global.rules, ...project, ...session], diagnostics, truncated };
  }

  async load(input: RulesInput = {}): Promise<RulesLoadResult> {
    const catalog = await this.list(input);
    const diagnostics = [...catalog.diagnostics];
    const eligible = catalog.rules.filter((rule) => {
      if (rule.source === 'project' && !rule.trusted) diagnostics.push('项目规则尚未信任：' + rule.name);
      return rule.enabled && rule.trusted && !rule.blocked && Boolean(rule.content.trim());
    });
    const selected: RuleEntry[] = [];
    let remaining = this.maxChars;
    let truncated = catalog.truncated;
    // Reserve space for higher-priority project/session rules, then restore merge order.
    for (const rule of [...eligible].reverse()) {
      if (!remaining) { truncated = true; diagnostics.push('规则超出 ' + this.maxChars + ' 字符上限，已省略：' + rule.name); continue; }
      let content = rule.content.slice(0, remaining);
      if (content.length && /[\uD800-\uDBFF]/.test(content.at(-1)!)) content = content.slice(0, -1);
      const shortened = content.length < rule.content.length;
      if (shortened) { truncated = true; diagnostics.push('规则超出 ' + this.maxChars + ' 字符上限，已截断：' + rule.name); }
      if (content) { selected.unshift({ ...rule, content, ...(shortened ? { truncated: true } : {}) }); remaining -= content.length; }
    }
    return { rules: selected, diagnostics, truncated, usedChars: this.maxChars - remaining };
  }

  saveGlobal(input: GlobalRuleInput): Promise<RuleEntry> { return this.global.saveGlobal(input); }
  setEnabled(name: string, enabled: boolean): Promise<RuleEntry> { return this.global.setEnabled(name, enabled); }
  removeGlobal(name: string): Promise<boolean> { return this.global.removeGlobal(name); }

  async trustProject(projectRoot: string, file: string, expectedHash: string): Promise<RuleEntry> {
    const catalog = await this.list({ projectRoot });
    const root = await fs.promises.realpath(projectRoot);
    const expected = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
    const entry = catalog.project.find((rule) => rule.path === expected);
    if (!entry) throw new Error('项目规则不存在或不可读取，请刷新后重试');
    if (entry.blocked) throw new Error(entry.blocked);
    if (typeof expectedHash !== 'string' || entry.hash !== expectedHash) throw new Error('规则内容已变化，请重新查看后确认');
    this.options.trustStore.grant({ projectRoot: root, file: path.relative(root, entry.path).split(path.sep).join('/'), sha256: entry.hash });
    return { ...entry, trusted: true };
  }
  private message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
