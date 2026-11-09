import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SkillManager } from '@core/agent/SkillManager';
import { ToolTrustStore } from '@core/security/ToolTrustStore';

const temporary: string[] = [];
function directory() { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-extensions-'))); temporary.push(root); return root; }
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('extension asset stores', () => {
  it('previews and imports an ordinary skill snapshot with its supporting files', async () => {
    const agent = directory(); const source = path.join(directory(), 'format-guide'); fs.mkdirSync(path.join(source, 'references'), { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: format-guide\ndescription: Format source files\n---\nUse the project formatter.');
    fs.writeFileSync(path.join(source, 'references/guide.md'), 'Follow existing project conventions.');
    const manager = new SkillManager(agent); const preview = await manager.preview(source);
    expect(preview.fileCount).toBe(2); expect(preview.content).toContain('Format source files');
    await manager.import(source, preview.hash);
    expect(fs.readFileSync(path.join(agent, 'skills/format-guide/references/guide.md'), 'utf8')).toBe('Follow existing project conventions.');
    const skillFile = path.join(agent, 'skills/format-guide/SKILL.md'); expect(manager.isEnabled(skillFile)).toBe(true);
    manager.setEnabled('format-guide', false); expect(manager.isEnabled(skillFile)).toBe(false);
    expect(new SkillManager(agent).isEnabled(skillFile)).toBe(false);
    manager.setEnabled('format-guide', true); expect(manager.isEnabled(skillFile)).toBe(true);
  });
  it('requires a fresh preview when an ordinary skill document changes', async () => {
    const agent = directory(); const source = path.join(directory(), 'format-guide'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'SKILL.md'), 'First version');
    const manager = new SkillManager(agent); const preview = await manager.preview(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'Second version'); await expect(manager.import(source, preview.hash)).rejects.toThrow('变化');
  });
  it('uses the skill file size limit for a complete ordinary markdown preview', async () => {
    const agent = directory(); const source = path.join(directory(), 'reference-guide'); fs.mkdirSync(source);
    const content = '# Ordinary reference guide' + String.fromCharCode(10) + ('Read the project conventions.' + String.fromCharCode(10)).repeat(12_000);
    fs.writeFileSync(path.join(source, 'SKILL.md'), content);
    const manager = new SkillManager(agent); const preview = await manager.preview(source);
    expect(preview.content).toBe(content);
    await manager.import(source, preview.hash);
    expect(fs.readFileSync(path.join(manager.skillsDir, 'reference-guide/SKILL.md'), 'utf8')).toBe(content);
  });
  it('keeps tool trust choices persistent and independent from returned snapshots', () => {
    const file = path.join(directory(), 'tool-trust.json'); const trust = new ToolTrustStore(file);
    trust.set('mcp__docs__search', 'auto'); trust.set('read', 'ask'); trust.set('write', 'disabled');
    const snapshot = trust.list(); snapshot.read = 'auto';
    expect(trust.get('read')).toBe('ask'); expect(new ToolTrustStore(file).get('mcp__docs__search')).toBe('auto');
  });
  it('keeps file writes and commands under the run permission mode', () => {
    const trust = new ToolTrustStore(path.join(directory(), 'tool-trust.json'));
    for (const name of ['run_command', 'write', 'edit']) expect(() => trust.set(name, 'auto')).toThrow('运行权限模式');
    expect(trust.get('run_command')).toBeUndefined();
  });
});
