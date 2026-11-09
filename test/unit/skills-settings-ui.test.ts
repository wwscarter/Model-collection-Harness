// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsSettings } from '../../src/renderer/components/SkillsSettings';
import type { SkillsApi, SkillsListing } from '../../src/renderer/skillsTypes';

let root: Root;
let container: HTMLDivElement;
let records: SkillsListing;
let list: ReturnType<typeof vi.fn<SkillsApi['list']>>;
let previewImport: ReturnType<typeof vi.fn<SkillsApi['previewImport']>>;
let confirmImport: ReturnType<typeof vi.fn<SkillsApi['confirmImport']>>;
let setEnabled: ReturnType<typeof vi.fn<SkillsApi['setEnabled']>>;
let openDirectory: ReturnType<typeof vi.fn<SkillsApi['openDirectory']>>;
let api: SkillsApi;
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === name)!;
const click = async (name: string) => { await act(async () => button(name).click()); };
const render = async () => { await act(async () => root.render(createElement(SkillsSettings, { api }))); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  records = { skills: [{ id: 'ordinary-directory', name: 'Ordinary Skill', description: '概述普通项目文件。', path: '/agent/skills/ordinary-directory/SKILL.md', enabled: true }], diagnostics: [] };
  list = vi.fn<SkillsApi['list']>(async () => structuredClone(records));
  previewImport = vi.fn<SkillsApi['previewImport']>(async () => ({ token: 'opaque-review-token', preview: { name: 'imported-skill', content: '# Ordinary Skill\n\n普通技能说明。', fileCount: 3, totalBytes: 2048, hash: 'ordinary-hash' } }));
  confirmImport = vi.fn<SkillsApi['confirmImport']>(async () => { records.skills.push({ id: 'imported-skill', name: 'Imported Skill', description: '已导入的普通技能。', path: '/agent/skills/imported-skill/SKILL.md', enabled: true }); });
  setEnabled = vi.fn<SkillsApi['setEnabled']>(async (id, enabled) => { records.skills = records.skills.map((skill) => skill.id === id ? { ...skill, enabled } : skill); });
  openDirectory = vi.fn<SkillsApi['openDirectory']>(async () => undefined);
  api = { list, previewImport, confirmImport, setEnabled, openDirectory };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('skill management settings', () => {
  it('renders descriptions and diagnostics and toggles using the directory identity', async () => {
    records.diagnostics = ['一个普通技能尚未填写完整描述。'];
    await render();
    expect(container.querySelector('[aria-label="技能 Ordinary Skill"]')!.textContent).toContain('概述普通项目文件。');
    expect(container.querySelector('[aria-label="技能加载诊断"]')!.textContent).toContain('一个普通技能尚未填写完整描述。');
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="启用技能 Ordinary Skill"]')!.click());
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith('ordinary-directory', false);
    expect(container.querySelector<HTMLInputElement>('[aria-label="启用技能 Ordinary Skill"]')!.checked).toBe(false);
  });

  it('opens the managed skills folder and imports only after preview confirmation', async () => {
    await render();
    await click('打开技能目录');
    expect(openDirectory).toHaveBeenCalledOnce();
    await click('从文件夹导入');
    expect(previewImport).toHaveBeenCalledExactlyOnceWith();
    expect(container.querySelector('[aria-label="SKILL.md 完整内容"]')!.textContent).toBe('# Ordinary Skill\n\n普通技能说明。');
    expect(container.querySelector('[aria-label="技能导入预览"]')!.textContent).toContain('3 个文件');
    expect(confirmImport).not.toHaveBeenCalled();
    await click('确认导入技能');
    expect(confirmImport).toHaveBeenCalledExactlyOnceWith('opaque-review-token');
    expect(container.querySelector('[aria-label="技能 Imported Skill"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="技能导入预览"]')).toBeNull();
  });

  it('can cancel a folder selection or the preview without importing anything', async () => {
    await render();
    previewImport.mockResolvedValueOnce(undefined);
    await click('从文件夹导入');
    expect(container.querySelector('[aria-label="技能导入预览"]')).toBeNull();
    await click('从文件夹导入');
    await click('取消导入');
    expect(confirmImport).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="技能导入预览"]')).toBeNull();
  });

  it('keeps a preview available after an ordinary import error for retry', async () => {
    await render(); await click('从文件夹导入');
    confirmImport.mockRejectedValueOnce(new Error('普通技能复制失败'));
    await click('确认导入技能');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('普通技能复制失败');
    expect(container.querySelector('[aria-label="技能导入预览"]')).not.toBeNull();
    await click('确认导入技能');
    expect(confirmImport).toHaveBeenCalledTimes(2);
  });

  it('retries an initial listing failure and does not manufacture an empty success list', async () => {
    list.mockRejectedValueOnce(new Error('普通技能列表读取失败'));
    await render();
    expect(button('从文件夹导入').disabled).toBe(true);
    await click('重新读取');
    expect(container.querySelector('[aria-label="技能 Ordinary Skill"]')).not.toBeNull();
  });
});
