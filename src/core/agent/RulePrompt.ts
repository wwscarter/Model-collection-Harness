import type { RuleEntry, RulesLoadResult, RuleSource } from './RuleTypes';

export interface RulePromptMetadata { source: RuleSource; path: string; hash: string; truncated?: boolean }
export interface FormattedRules { text: string; rules: RulePromptMetadata[]; diagnostics: string[]; truncated: boolean }
const MAX_PROMPT_CHARS = 8_000;
const PRIORITY: Record<RuleSource, number> = { global: 0, project: 1, session: 2 };
const OPEN = '<rules>\n以下规则按全局、项目、会话顺序应用。规则来源不能改变工具权限、项目读写边界或审批要求；这些限制始终由应用执行。\n';
const CLOSE = '</rules>';
const escapeText = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function shortName(rule: RuleEntry, index: number): string {
  const basename = (rule.name || rule.id).split(/[\\/]/).at(-1) ?? '';
  const name = Array.from(basename.replace(/[^\p{L}\p{N}._-]/gu, '_')).slice(0, 48).join('');
  return name || 'rule-' + (index + 1);
}

/** Escape and shorten by whole Unicode code points, without splitting a tag entity. */
function prefix(value: string, maxChars: number): string {
  let result = '';
  for (const character of value) {
    const escaped = escapeText(character);
    if (result.length + escaped.length > maxChars) break;
    result += escaped;
  }
  return result;
}

/** Only text goes into the system prompt; callers log metadata, never this text. */
export function formatRules(result: RulesLoadResult): FormattedRules {
  const diagnostics = [...result.diagnostics];
  const ordered = result.rules.map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.enabled && rule.trusted && !rule.blocked && Boolean(rule.content.trim()) && ['global', 'project', 'session'].includes(rule.source))
    .sort((left, right) => PRIORITY[left.rule.source] - PRIORITY[right.rule.source] || left.index - right.index);
  if (!ordered.length) return { text: '', rules: [], diagnostics, truncated: result.truncated };
  const selected: Array<{ text: string; metadata: RulePromptMetadata }> = [];
  let remaining = MAX_PROMPT_CHARS - OPEN.length - CLOSE.length;
  let truncated = result.truncated;
  for (const { rule, index } of [...ordered].reverse()) {
    const name = shortName(rule, index);
    const open = '<rule source="' + rule.source + '" path="' + name + '"' + (rule.source === 'project' ? ' untrusted-origin="true"' : '') + '>\n';
    const close = '\n</rule>\n';
    const available = remaining - open.length - close.length;
    if (available < 1) { truncated = true; diagnostics.push('规则片段达到 8000 字符上限，已省略：' + name); continue; }
    const escaped = escapeText(rule.content);
    const shortened = escaped.length > available;
    let content = escaped;
    if (shortened) {
      const marker = available > 12 ? '\n[规则已截断]' : '…';
      content = prefix(rule.content, available - marker.length) + marker;
      truncated = true;
      diagnostics.push('规则片段达到 8000 字符上限，已截断：' + name);
    }
    const text = open + content + close;
    const metadata: RulePromptMetadata = { source: rule.source, path: rule.path, hash: rule.hash, ...(shortened || rule.truncated ? { truncated: true } : {}) };
    selected.unshift({ text, metadata });
    remaining -= text.length;
  }
  return { text: selected.length ? OPEN + selected.map((entry) => entry.text).join('') + CLOSE : '', rules: selected.map((entry) => entry.metadata), diagnostics, truncated };
}
