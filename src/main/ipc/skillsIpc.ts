import { dialog, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import type { SkillManager } from '@core/agent/SkillManager';
import type { MainContext } from '../MainContext';
import { handle } from './register';

export function register(ctx: MainContext & { skillManager: SkillManager }): void {
  const imports = new Map<string, { source: string; hash: string; expires: number }>();
  handle('agent:skills:list', () => {
    const loaded = loadSkillsFromDir({ dir: ctx.skillManager.skillsDir, source: 'newai' });
    const state = ctx.skillManager.state();
    return {
      skills: loaded.skills.map((skill) => ({ id: path.relative(ctx.skillManager.skillsDir, skill.filePath).split(path.sep)[0], name: skill.name, description: skill.description, path: skill.filePath, enabled: ctx.skillManager.isEnabled(skill.filePath) })),
      diagnostics: [...state.diagnostics, ...loaded.diagnostics.map((item) => item.message)],
    };
  });
  handle('agent:skills:open-directory', async () => {
    const error = await shell.openPath(ctx.skillManager.skillsDir);
    if (error) throw new Error('无法打开技能目录：' + error);
    return { success: true };
  });
  handle('agent:skills:set-enabled', (_event, name: unknown, enabled: unknown) => ctx.skillManager.setEnabled(name, enabled));
  handle('agent:skills:preview-import', async () => {
    const window = ctx.getWindow();
    const options = { title: '选择要导入的技能目录', properties: ['openDirectory'] as ('openDirectory')[] };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length !== 1) return undefined;
    const source = picked.filePaths[0];
    const preview = await ctx.skillManager.preview(source);
    for (const [token, item] of imports) if (item.expires <= Date.now()) imports.delete(token);
    if (imports.size >= 20) imports.delete(imports.keys().next().value!);
    const token = randomUUID(); imports.set(token, { source, hash: preview.hash, expires: Date.now() + 600_000 });
    return { token, preview };
  });
  handle('agent:skills:confirm-import', async (_event, token: unknown) => {
    if (typeof token !== 'string') throw new Error('技能导入确认无效');
    const pending = imports.get(token);
    if (!pending || pending.expires <= Date.now()) { imports.delete(token); throw new Error('技能预览已过期，请重新选择文件夹'); }
    const result = await ctx.skillManager.import(pending.source, pending.hash);
    imports.delete(token);
    return result;
  });
}
