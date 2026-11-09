// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HooksSettings } from '../../src/renderer/components/HooksSettings';
import type { HookConfig } from '../../src/core/hooks/HookConfig';
import type { HooksApi, HooksListing } from '../../src/renderer/hooksTypes';

let root: Root;
let container: HTMLDivElement;
let records: HooksListing;
let list: ReturnType<typeof vi.fn<HooksApi['list']>>;
let saveGlobal: ReturnType<typeof vi.fn<HooksApi['saveGlobal']>>;
let trustProject: ReturnType<typeof vi.fn<HooksApi['trustProject']>>;
let api: HooksApi;
const button = (name: string, scope: ParentNode = container) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === name)!;
const click = async (name: string, scope: ParentNode = container) => { await act(async () => { button(name, scope).click(); }); };
const editor = () => container.querySelector<HTMLTextAreaElement>('[aria-label="Hooks JSON 配置"]')!;
const edit = async (text: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor(), text); editor().dispatchEvent(new Event('input', { bubbles: true })); });
};
const render = async () => { await act(async () => { root.render(createElement(HooksSettings, { api })); }); };
const config = (): HookConfig => ({ version: 1, hooks: [{ id: 'ordinary-format', event: 'post_tool', match: { tool: ['write'], glob: '*.ts' }, run: 'npm run format', timeoutMs: 1200, onFailure: 'report' }] });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  records = { global: { source: 'global', path: '/agent/hooks.json', content: JSON.stringify(config(), null, 2), hash: 'global', trusted: true, config: config() }, project: { source: 'project', path: '/project/.newai/hooks.json', content: JSON.stringify({ version: 1, hooks: [] }, null, 2), hash: 'project', trusted: false, config: { version: 1, hooks: [] } }, diagnostics: [] };
  list = vi.fn<HooksApi['list']>(async () => structuredClone(records));
  saveGlobal = vi.fn<HooksApi['saveGlobal']>(async (saved) => { records.global = { source: 'global', path: '/agent/hooks.json', content: JSON.stringify(saved, null, 2), hash: 'saved', trusted: true, config: saved }; });
  trustProject = vi.fn<HooksApi['trustProject']>(async () => { records.project!.trusted = true; });
  api = { list, saveGlobal, trustProject };
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('declarative Hooks extension settings', () => {
  it('shows events, commands, matching rules, timeouts and failure behavior', async () => {
    await render();
    const card = container.querySelector('[aria-label="Hook ordinary-format"]')!;
    expect(card.textContent).toContain('工具完成后 · post_tool');
    expect(card.textContent).toContain('npm run format');
    expect(card.textContent).toContain('write');
    expect(card.textContent).toContain('*.ts');
    expect(card.textContent).toContain('1200 ms');
    expect(card.textContent).toContain('报告结果');
    expect(container.textContent).toContain('连续失败 3 次');
    expect(button('保存 Hooks').disabled).toBe(true);
  });

  it('adds both supplied examples and saves their declarative configuration', async () => {
    records.global = undefined;
    await render();
    await click('添加 TS 格式化示例');
    await click('添加 pre_tool 阻止示例');
    await click('添加 TS 格式化示例');
    expect(container.querySelectorAll('article[aria-label^="Hook "]')).toHaveLength(3);
    await click('保存 Hooks');
    expect(saveGlobal).toHaveBeenCalledOnce();
    expect(saveGlobal.mock.calls[0][0].hooks).toMatchObject([
      { id: 'format-typescript', event: 'post_tool', run: 'npx prettier --write {{files}}' },
      { id: 'protect-lockfile', event: 'pre_tool', action: 'block' },
      { id: 'format-typescript-2', event: 'post_tool' },
    ]);
    expect(button('保存 Hooks').disabled).toBe(true);
  });

  it('edits, disables and removes global hooks as a draft before saving', async () => {
    await render();
    const changed = config(); changed.hooks[0].run = 'npm run lint';
    await edit(JSON.stringify(changed));
    expect(container.querySelector('[aria-label="Hook ordinary-format"]')!.textContent).toContain('npm run lint');
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="启用 Hook ordinary-format"]')!.click());
    expect(saveGlobal).not.toHaveBeenCalled();
    await click('保存 Hooks');
    expect(saveGlobal.mock.calls[0][0].hooks[0]).toMatchObject({ run: 'npm run lint', enabled: false });
    await click('删除', container.querySelector('[aria-label="Hook ordinary-format"]')!);
    await click('保存 Hooks');
    expect(saveGlobal.mock.calls[1][0].hooks).toEqual([]);
  });

  it('shows parse diagnostics without saving an invalid draft', async () => {
    await render();
    await edit('{ ordinary draft is incomplete');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('配置诊断');
    expect(button('保存 Hooks').disabled).toBe(true);
    expect(saveGlobal).not.toHaveBeenCalled();
    await edit(JSON.stringify({ version: 1, hooks: [] }));
    await click('格式化 JSON');
    expect(editor().value).toBe(JSON.stringify({ version: 1, hooks: [] }, null, 2));
  });

  it('requires complete project preview before a separate trust action', async () => {
    records.project!.content += '\n' + ' '.repeat(2000);
    await render();
    expect(trustProject).not.toHaveBeenCalled();
    expect(button('确认信任此 Hooks 配置')).toBeUndefined();
    await click('查看并信任');
    expect(container.querySelector('[aria-label="项目 Hooks 完整内容"]')!.textContent).toBe(records.project!.content);
    expect(trustProject).not.toHaveBeenCalled();
    await click('确认信任此 Hooks 配置');
    expect(trustProject).toHaveBeenCalledExactlyOnceWith('project');
    expect(container.querySelector('[aria-label="项目 Hooks 预览"]')).toBeNull();
    expect(container.textContent).toContain('已信任');
  });

  it('preserves a changed JSON draft when saving fails', async () => {
    await render();
    await click('添加 TS 格式化示例');
    const draft = editor().value;
    saveGlobal.mockRejectedValueOnce(new Error('普通配置保存失败'));
    await click('保存 Hooks');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('普通配置保存失败');
    expect(editor().value).toBe(draft);
    expect(button('保存 Hooks').disabled).toBe(false);
    await click('保存 Hooks');
    expect(saveGlobal).toHaveBeenCalledTimes(2);
  });

  it('reports a project configuration read error without offering trust', async () => {
    records.project = { ...records.project!, config: undefined, error: '普通 JSON 配置尚未写完' }; records.diagnostics = ['项目配置需要修正'];
    await render();
    await click('查看配置');
    expect(container.textContent).toContain('普通 JSON 配置尚未写完');
    expect(container.querySelector('[aria-label="Hooks 加载诊断"]')!.textContent).toContain('项目配置需要修正');
    expect(button('确认信任此 Hooks 配置')).toBeUndefined();
  });

  it('retries a failed initial list read before displaying the editor', async () => {
    list.mockRejectedValueOnce(new Error('普通 Hooks 列表读取失败'));
    await render();
    expect(editor()).toBeNull();
    await click('重新读取');
    expect(editor()).not.toBeNull();
  });
});
