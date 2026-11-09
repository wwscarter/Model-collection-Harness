import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RulesLoader } from '@core/agent/RulesLoader';
import { ruleId } from '@core/agent/RuleFiles';
import { TrustStore } from '@core/security/TrustStore';

let directory: string;
let root: string;
let agentDir: string;
let trust: TrustStore;
let loader: RulesLoader;
function projectFile(name: string, content: string): void {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
}
async function trustAll(): Promise<void> {
  for (const entry of (await loader.list({ projectRoot: root })).project) await loader.trustProject(root, entry.path, entry.hash);
}
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-rules-')));
  root = path.join(directory, 'project'); agentDir = path.join(directory, 'data', 'agent'); fs.mkdirSync(root);
  trust = new TrustStore(path.join(directory, 'data', 'trust.json')); loader = new RulesLoader({ agentDir, trustStore: trust });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('rule catalog and explicit project trust', () => {
  it('lists ordinary project text for preview without injecting it before confirmation', async () => {
    await loader.saveGlobal({ name: 'style', content: 'Use short comments.' });
    projectFile('AGENTS.md', 'Explain project changes in Chinese.');
    const catalog = await loader.list({ projectRoot: root, sessionRules: 'Keep this answer concise.' });
    expect(catalog.project[0]).toMatchObject({ name: 'AGENTS.md', content: 'Explain project changes in Chinese.', trusted: false, enabled: true, hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const loaded = await loader.load({ projectRoot: root, sessionRules: 'Keep this answer concise.' });
    expect(loaded.rules.map((entry) => entry.source)).toEqual(['global', 'session']);
    expect(loaded.diagnostics).toEqual([expect.stringContaining('尚未信任')]);
    expect(fs.existsSync(path.join(agentDir, 'session.md'))).toBe(false);
  });

  it('loads global, project and temporary rules in precedence order with stable file ordering', async () => {
    await loader.saveGlobal({ name: '20-style', content: 'Use descriptive names.' });
    await loader.saveGlobal({ name: '10-language', content: 'Use Chinese for explanations.' });
    projectFile('AGENTS.md', 'Prefer local examples.');
    projectFile('.newai/rules/20-tests.md', 'Describe ordinary test results.');
    projectFile('.newai/rules/10-format.md', 'Keep formatting consistent.');
    await trustAll();
    const loaded = await loader.load({ projectRoot: root, sessionRules: 'Answer in two paragraphs.' });
    expect(loaded.rules.map((entry) => entry.name)).toEqual(['10-language', '20-style', 'AGENTS.md', '10-format.md', '20-tests.md', '本会话规则']);
    expect(loaded.rules.every((entry) => entry.trusted)).toBe(true);
    expect(loaded.truncated).toBe(false);
  });

  it('requires another preview after an ordinary project rule changes', async () => {
    projectFile('AGENTS.md', 'Prefer readable examples.');
    const first = (await loader.list({ projectRoot: root })).project[0];
    await loader.trustProject(root, first.path, first.hash);
    projectFile('AGENTS.md', 'Prefer readable examples and brief explanations.');
    await expect(loader.trustProject(root, first.path, first.hash)).rejects.toThrow('内容已变化');
    const current = (await loader.list({ projectRoot: root })).project[0];
    expect(current.hash).not.toBe(first.hash); expect(current.trusted).toBe(false);
    expect((await loader.load({ projectRoot: root })).rules).toEqual([]);
  });

  it('retains higher-priority rules while enforcing the 8000-character total', async () => {
    await loader.saveGlobal({ name: 'general', content: 'G'.repeat(5_000) });
    projectFile('AGENTS.md', 'P'.repeat(5_000)); await trustAll();
    const loaded = await loader.load({ projectRoot: root, sessionRules: 'S'.repeat(500) });
    expect(loaded.usedChars).toBe(8_000); expect(loaded.truncated).toBe(true);
    expect(loaded.rules.map((entry) => [entry.source, entry.content.length])).toEqual([['global', 2_500], ['project', 5_000], ['session', 500]]);
    expect(loaded.diagnostics).toEqual([expect.stringContaining('截断')]);
  });

  it('reports omitted low-priority rules when the selected sources fill the limit', async () => {
    const small = new RulesLoader({ agentDir, trustStore: trust, maxChars: 20 });
    await small.saveGlobal({ name: 'general', content: 'G'.repeat(12) });
    projectFile('AGENTS.md', 'P'.repeat(12)); await trustAll();
    const loaded = await small.load({ projectRoot: root, sessionRules: 'S'.repeat(8) });
    expect(loaded.rules.map((entry) => entry.source)).toEqual(['project', 'session']);
    expect(loaded.usedChars).toBe(20); expect(loaded.diagnostics).toEqual([expect.stringContaining('省略')]);
  });

  it('blocks explicitly synthetic credential metadata without exposing it in previews or diagnostics', async () => {
    const synthetic = 'SYNTHETIC TEST DATA ONLY: sk-synthetic-placeholder-000000';
    await expect(loader.saveGlobal({ name: 'synthetic', content: synthetic })).rejects.toThrow('拒绝保存');
    fs.mkdirSync(path.join(agentDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'rules', 'manual-synthetic.md'), synthetic);
    projectFile('AGENTS.md', synthetic);
    const catalog = await loader.list({ projectRoot: root, sessionRules: synthetic });
    expect(catalog.global[0]).toMatchObject({ blocked: expect.any(String), content: '', trusted: true });
    expect(catalog.project[0]).toMatchObject({ blocked: expect.any(String), content: '' });
    expect(catalog.session[0]).toMatchObject({ blocked: expect.any(String), content: '' });
    expect(catalog.diagnostics.join('\n')).not.toContain('sk-synthetic');
    await expect(loader.trustProject(root, catalog.project[0].path, catalog.project[0].hash)).rejects.toThrow('拒绝加载');
    expect((await loader.load({ projectRoot: root, sessionRules: synthetic })).rules).toEqual([]);
  });

  it('honors cancellation before loading ordinary rules', async () => {
    const controller = new AbortController(); controller.abort(new Error('ordinary cancellation'));
    await expect(loader.load({ projectRoot: root, signal: controller.signal })).rejects.toThrow('ordinary cancellation');
  });

  it('rejects ordinary session input above the public 256KB limit in UTF-8 bytes', async () => {
    await expect(loader.list({ sessionRules: 'A'.repeat(256 * 1024 + 1) })).rejects.toThrow('256KB');
    await expect(loader.load({ sessionRules: '文'.repeat(Math.floor(256 * 1024 / 3) + 1) })).rejects.toThrow('256KB');
    expect((await loader.load({ sessionRules: 'A'.repeat(256 * 1024) })).usedChars).toBe(8_000);
  });
});

describe('global rule editing and enabled state', () => {
  it.each(['style', 'style.md', 'style.MD', '代码规范', '代码规范.md', 'notes.backup.md'])('normalizes ordinary rule name %s idempotently', async (name) => {
    const id = ruleId(name);
    expect(ruleId(id)).toBe(id);
    await loader.saveGlobal({ name, content: 'Ordinary naming convention.', enabled: true });
    expect((await loader.list()).global).toEqual([expect.objectContaining({ name: id, enabled: true })]);
    expect((await loader.load()).rules).toHaveLength(1);
  });

  it.each(['notes.md.md', 'notes.MD.md', '代码规范.md.md'])('rejects duplicate .md suffixes in %s without changing other enabled rules', async (name) => {
    await loader.saveGlobal({ name: 'existing', content: 'Ordinary existing rule.', enabled: true });
    await expect(loader.saveGlobal({ name, content: 'Ordinary proposed rule.', enabled: true })).rejects.toThrow('重复的 .md 后缀');
    const catalog = await loader.list();
    expect(catalog.global).toEqual([expect.objectContaining({ name: 'existing', enabled: true })]);
    expect(catalog.diagnostics).toEqual([]);
    expect(fs.readdirSync(path.join(agentDir, 'rules'))).toEqual(['existing.md']);
  });

  it('persists safe rule names, ordinary edits, enabled state and removal', async () => {
    const saved = await loader.saveGlobal({ name: '代码规范.md', content: 'Use readable identifiers.', enabled: false });
    expect(saved).toMatchObject({ name: '代码规范', enabled: false, trusted: true });
    expect((await loader.load()).rules).toEqual([]);
    await loader.saveGlobal({ name: '代码规范', content: 'Use readable identifiers and short comments.', enabled: false });
    await loader.setEnabled('代码规范', true);
    const reopened = new RulesLoader({ agentDir, trustStore: trust });
    expect((await reopened.load()).rules[0].content).toBe('Use readable identifiers and short comments.');
    expect(await loader.removeGlobal('代码规范')).toBe(true);
    expect(await loader.removeGlobal('代码规范')).toBe(false);
    expect((await loader.list()).global).toEqual([]);
  });

  it('serializes ordinary saves so disabled preferences are retained for every rule', async () => {
    await Promise.all([loader.saveGlobal({ name: 'first', content: 'First ordinary rule.', enabled: false }), loader.saveGlobal({ name: 'second', content: 'Second ordinary rule.', enabled: false })]);
    expect((await loader.list()).global.map((entry) => [entry.name, entry.enabled])).toEqual([['first', false], ['second', false]]);
    expect((await loader.load()).rules).toEqual([]);
  });

  it('restores the original global content if saving enabled state fails', async () => {
    await loader.saveGlobal({ name: 'style', content: 'Ordinary original style.', enabled: false });
    const original = fs.renameSync;
    let failed = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!failed && String(to).endsWith('rules-state.json')) { failed = true; throw new Error('ordinary state failure'); }
      return original(from, to);
    });
    await expect(loader.saveGlobal({ name: 'style', content: 'Ordinary revised style.', enabled: true })).rejects.toThrow('ordinary state failure');
    expect((await loader.list()).global[0]).toMatchObject({ content: 'Ordinary original style.', enabled: false });
  });
});
