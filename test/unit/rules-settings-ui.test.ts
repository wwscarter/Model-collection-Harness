// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RulesSettings } from '../../src/renderer/components/RulesSettings';
import type { GlobalRuleDraft, RulesApi, RulesListing } from '../../src/renderer/rulesTypes';

let root: Root;
let container: HTMLDivElement;
let records: RulesListing;
let list: ReturnType<typeof vi.fn<RulesApi['list']>>;
let saveGlobal: ReturnType<typeof vi.fn<RulesApi['saveGlobal']>>;
let setEnabled: ReturnType<typeof vi.fn<RulesApi['setEnabled']>>;
let removeGlobal: ReturnType<typeof vi.fn<RulesApi['removeGlobal']>>;
let trustProject: ReturnType<typeof vi.fn<RulesApi['trustProject']>>;
let api: RulesApi;
const button = (name: string, scope: ParentNode = container) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === name)!;
const click = async (name: string, scope: ParentNode = container) => { await act(async () => { button(name, scope).click(); }); };
const input = async (label: string, value: string) => {
  await act(async () => {
    const control = container.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-label="' + label + '"]')!;
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const render = async () => { await act(async () => { root.render(createElement(RulesSettings, { api })); }); };
const globalRule = () => container.querySelector<HTMLElement>('[aria-label="全局规则 working.md"]')!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  records = {
    global: [{ name: 'working.md', path: '/app/agent/rules/working.md', content: '请用中文说明普通项目变更。', hash: 'global-hash', enabled: true, trusted: true }],
    project: [{ name: 'AGENTS.md', path: '/project/AGENTS.md', content: '# 项目约定\n' + Array.from({ length: 80 }, (_, index) => '普通工作约定 ' + index).join('\n'), hash: 'project-hash', enabled: true, trusted: false }],
    diagnostics: [], truncated: false,
  };
  list = vi.fn<RulesApi['list']>(async () => structuredClone(records));
  saveGlobal = vi.fn<RulesApi['saveGlobal']>(async (rule: GlobalRuleDraft) => { records.global = [...records.global.filter((current) => current.name !== rule.name), { ...rule, path: '/app/agent/rules/' + rule.name, hash: 'saved-hash', trusted: true }]; });
  setEnabled = vi.fn<RulesApi['setEnabled']>(async (name: string, enabled: boolean) => { records.global = records.global.map((rule) => rule.name === name ? { ...rule, enabled } : rule); });
  removeGlobal = vi.fn<RulesApi['removeGlobal']>(async (name: string) => { records.global = records.global.filter((rule) => rule.name !== name); });
  trustProject = vi.fn<RulesApi['trustProject']>(async (file: string) => { records.project = records.project.map((rule) => rule.path === file ? { ...rule, trusted: true } : rule); });
  api = { list, saveGlobal, setEnabled, removeGlobal, trustProject };
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('rules extension settings', () => {
  it('shows global and project trust states with loading diagnostics', async () => {
    records.diagnostics = ['一个普通规则文件尚未保存。']; records.truncated = true;
    await render();
    expect(globalRule().textContent).toContain('已信任');
    expect(container.querySelector('[aria-label="项目规则 AGENTS.md"]')!.textContent).toContain('待信任');
    expect(container.querySelector('[aria-label="规则加载诊断"]')!.textContent).toContain('一个普通规则文件尚未保存。');
    expect(container.textContent).toContain('规则已达到容量限制');
  });

  it('creates a global rule and refreshes the saved list', async () => {
    await render();
    await click('新建规则');
    await input('规则文件名', 'review.md');
    await input('规则内容', '请概述普通代码审查发现。');
    await click('保存规则');
    expect(saveGlobal).toHaveBeenCalledExactlyOnceWith({ name: 'review.md', content: '请概述普通代码审查发现。', enabled: true });
    expect(container.querySelector('[aria-label="全局规则 review.md"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="新建全局规则"]')).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('edits content without renaming an existing rule', async () => {
    await render();
    await click('编辑', globalRule());
    expect(container.querySelector<HTMLInputElement>('[aria-label="规则文件名"]')!.disabled).toBe(true);
    await input('规则内容', '请先阅读项目说明，再概述变更。');
    await click('保存规则');
    expect(saveGlobal).toHaveBeenCalledExactlyOnceWith({ name: 'working.md', content: '请先阅读项目说明，再概述变更。', enabled: true });
  });

  it('toggles a global rule and removes it through the provided API', async () => {
    await render();
    await act(async () => { container.querySelector<HTMLInputElement>('[aria-label="启用规则 working.md"]')!.click(); });
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith('working.md', false);
    expect(container.querySelector<HTMLInputElement>('[aria-label="启用规则 working.md"]')!.checked).toBe(false);
    await click('删除', globalRule());
    expect(removeGlobal).toHaveBeenCalledExactlyOnceWith('working.md');
    expect(container.querySelector('[aria-label="全局规则 working.md"]')).toBeNull();
  });

  it('requires a full content preview and a separate trust action for project rules', async () => {
    await render();
    expect(trustProject).not.toHaveBeenCalled();
    expect(button('确认信任此内容')).toBeUndefined();
    await click('查看并信任');
    expect(container.querySelector('[aria-label="项目规则完整内容"]')!.textContent).toBe(records.project[0].content);
    expect(trustProject).not.toHaveBeenCalled();
    await click('确认信任此内容');
    expect(trustProject).toHaveBeenCalledExactlyOnceWith('/project/AGENTS.md', 'project-hash');
    expect(container.querySelector('[aria-label="项目规则预览"]')).toBeNull();
    expect(container.querySelector('[aria-label="项目规则 AGENTS.md"]')!.textContent).toContain('已信任');
  });

  it('keeps an unsuccessful save draft available for retry', async () => {
    await render();
    await click('新建规则');
    await input('规则文件名', 'notes.md');
    await input('规则内容', '记录普通项目约定。');
    saveGlobal.mockRejectedValueOnce(new Error('普通文件保存失败'));
    await click('保存规则');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('普通文件保存失败');
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="规则内容"]')!.value).toBe('记录普通项目约定。');
    await click('保存规则');
    expect(saveGlobal).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-label="全局规则 notes.md"]')).not.toBeNull();
  });

  it('retries a failed initial list read before enabling edits', async () => {
    list.mockRejectedValueOnce(new Error('普通规则列表读取失败'));
    await render();
    expect(button('新建规则').disabled).toBe(true);
    await click('重新读取');
    expect(globalRule()).not.toBeNull();
    expect(button('新建规则').disabled).toBe(false);
  });

  it('keeps the current listing when an earlier API read finishes later', async () => {
    let finishEarlier!: (value: RulesListing) => void;
    list.mockImplementationOnce(() => new Promise<RulesListing>((resolve) => { finishEarlier = resolve; }));
    await render();
    const next: RulesListing = { ...structuredClone(records), project: [{ ...records.project[0], name: 'PROJECT.md', path: '/other/PROJECT.md' }] };
    const nextApi = { ...api, list: async () => next };
    await act(async () => { root.render(createElement(RulesSettings, { api: nextApi })); });
    expect(container.querySelector('[aria-label="项目规则 PROJECT.md"]')).not.toBeNull();
    await act(async () => { finishEarlier(structuredClone(records)); });
    expect(container.querySelector('[aria-label="项目规则 PROJECT.md"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="项目规则 AGENTS.md"]')).toBeNull();
  });
});
