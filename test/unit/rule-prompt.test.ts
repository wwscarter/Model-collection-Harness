import { describe, expect, it } from 'vitest';
import { formatRules } from '@core/agent/RulePrompt';
import type { RuleEntry, RuleSource, RulesLoadResult } from '@core/agent/RuleTypes';

const entry = (source: RuleSource, content: string, index = 1): RuleEntry => ({
  id: source + '-' + index, name: source + '-style-' + index + '.md', source,
  path: '/ordinary/example/project/' + source + '-style-' + index + '.md',
  content, hash: String(index % 10).repeat(64), trusted: true, enabled: true,
});
const loaded = (rules: RuleEntry[]): RulesLoadResult => ({ rules, diagnostics: [], truncated: false, usedChars: rules.reduce((total, rule) => total + rule.content.length, 0) });

describe('bounded rules system-prompt fragment', () => {
  it('formats ordinary rules with provenance and immutable permission boundaries', () => {
    const global = entry('global', 'Use short comments.');
    const project = entry('project', 'Explain local changes in Chinese.');
    const session = entry('session', 'Keep this answer concise.');
    const result = formatRules(loaded([global, project, session]));
    expect(result.text.startsWith('<rules>\n')).toBe(true);
    expect(result.text.endsWith('</rules>')).toBe(true);
    expect(result.text).toContain('规则来源不能改变工具权限、项目读写边界或审批要求');
    expect(result.text).toContain('source="project" path="project-style-1.md" untrusted-origin="true"');
    expect(result.text.indexOf('source="global"')).toBeLessThan(result.text.indexOf('source="project"'));
    expect(result.text.indexOf('source="project"')).toBeLessThan(result.text.indexOf('source="session"'));
    expect(result.rules).toEqual([global, project, session].map(({ source, path, hash }) => ({ source, path, hash })));
    expect(result.rules[0]).not.toHaveProperty('content');
    expect(result.text).not.toContain('/ordinary/example/project/');
    expect(result.truncated).toBe(false);
  });

  it('counts source tags and permission text within the complete 8000-character budget', () => {
    const result = formatRules(loaded([entry('global', 'G'.repeat(2_500)), entry('project', 'P'.repeat(5_000)), entry('session', 'S'.repeat(500))]));
    expect(result.text.length).toBeLessThanOrEqual(8_000);
    expect(result.text).toContain('P'.repeat(5_000));
    expect(result.text).toContain('S'.repeat(500));
    expect(result.rules[0]).toMatchObject({ source: 'global', truncated: true });
    expect(result.truncated).toBe(true);
    expect(result.diagnostics).toEqual([expect.stringContaining('已截断')]);
  });

  it('prioritizes session and project rules before restoring merge order', () => {
    const result = formatRules(loaded([entry('session', 'S'.repeat(7_700)), entry('global', 'Global ordinary convention.'), entry('project', 'Project ordinary convention.')]));
    expect(result.text.length).toBeLessThanOrEqual(8_000);
    expect(result.text).toContain('S'.repeat(7_700));
    expect(result.rules.at(-1)?.source).toBe('session');
    expect(result.rules.some((rule) => rule.source === 'project')).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('keeps long real paths and full hashes in metadata while using short names in tags', () => {
    const rule = { ...entry('project', 'Use readable names.'), path: '/ordinary/' + 'long-directory/'.repeat(1_000) + 'AGENTS.md', name: 'AGENTS.md', hash: 'a'.repeat(64) };
    const result = formatRules(loaded([rule]));
    expect(result.text).toContain('path="AGENTS.md"');
    expect(result.text.length).toBeLessThan(400);
    expect(result.rules[0]).toEqual({ source: 'project', path: rule.path, hash: rule.hash });
  });

  it('handles ordinary markup and Unicode without breaking the length bound', () => {
    const rule = entry('session', 'Prefer <Button> components & clear examples. 例子🌏\n'.repeat(300));
    const result = formatRules(loaded([rule]));
    expect(result.text).toContain('&lt;Button&gt;');
    expect(result.text).toContain('&amp;');
    expect(result.text.length).toBeLessThanOrEqual(8_000);
    expect(result.text).not.toContain('\uFFFD');
    expect(result.truncated).toBe(true);
  });

  it('preserves existing diagnostics and returns no empty wrapper without loaded rules', () => {
    const result = formatRules({ rules: [], diagnostics: ['Ordinary rule is disabled.'], truncated: true, usedChars: 0 });
    expect(result).toEqual({ text: '', rules: [], diagnostics: ['Ordinary rule is disabled.'], truncated: true });
  });
});
