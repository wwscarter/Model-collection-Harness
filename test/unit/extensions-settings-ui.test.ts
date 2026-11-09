// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../../src/renderer/pages/Settings';
import type { AmdApi } from '../../src/renderer/types';
import type { RulesApi, RulesListing } from '../../src/renderer/rulesTypes';
import type { HooksApi } from '../../src/renderer/hooksTypes';

let root: Root;
let container: HTMLDivElement;
let rules: RulesListing;
let list: ReturnType<typeof vi.fn<RulesApi['list']>>;
let trustProject: ReturnType<typeof vi.fn<RulesApi['trustProject']>>;
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  rules = { global: [{ name: 'working', path: '/agent/rules/working.md', content: '解释普通项目变更。', hash: 'global', enabled: true, trusted: true }], project: [{ name: 'AGENTS.md', path: '/project/AGENTS.md', content: '保持项目现有格式。', hash: 'project', enabled: true, trusted: false }], diagnostics: [], truncated: false };
  list = vi.fn<RulesApi['list']>(async () => structuredClone(rules));
  trustProject = vi.fn<RulesApi['trustProject']>(async () => { rules.project[0].trusted = true; });
  window.amd = { routingStatus: vi.fn(async () => ({ backend: 'heuristic', available: false })), agent: { rules: { list, trustProject, saveGlobal: vi.fn(), setEnabled: vi.fn(), removeGlobal: vi.fn() } } } as unknown as AmdApi;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete window.amd; });

describe('extensions settings tab', () => {
  it('adds a third settings tab and mounts rules through the preload API', async () => {
    await act(async () => { root.render(createElement(Settings, { models: [], onClose: vi.fn(), onModelsChanged: vi.fn(), onOpenRouting: vi.fn() })); });
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['模型与端点', '运行与权限', '扩展']);
    expect(list).not.toHaveBeenCalled();
    await act(async () => { button('扩展').click(); });
    expect(button('扩展').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[aria-label="全局规则 working"]')).not.toBeNull();
    expect(list).toHaveBeenCalledOnce();
    await act(async () => { button('查看并信任').click(); });
    expect(container.querySelector('[aria-label="项目规则完整内容"]')!.textContent).toBe('保持项目现有格式。');
    expect(trustProject).not.toHaveBeenCalled();
    await act(async () => { button('确认信任此内容').click(); });
    expect(trustProject).toHaveBeenCalledExactlyOnceWith('/project/AGENTS.md', 'project');
  });

  it('opens the extensions tab directly and explains all capacity diagnostics', async () => {
    rules.truncated = true; rules.diagnostics = ['全局规则文件超过 64 条，列表已截断'];
    await act(async () => { root.render(createElement(Settings, { models: [], onClose: vi.fn(), onModelsChanged: vi.fn(), onOpenRouting: vi.fn(), initialTab: 'extensions' })); });
    expect(container.textContent).toContain('规则已达到容量限制');
    expect(container.textContent).toContain('全局规则文件超过 64 条');
    expect(container.textContent).not.toContain('因长度限制未被注入');
  });

  it('switches between Rules and Hooks subpages without calling Hooks until selected', async () => {
    const hooks: HooksApi = { list: vi.fn(async () => ({ diagnostics: [] })), saveGlobal: vi.fn(), trustProject: vi.fn() };
    window.amd!.agent.hooks = hooks;
    await act(async () => { root.render(createElement(Settings, { models: [], onClose: vi.fn(), onModelsChanged: vi.fn(), onOpenRouting: vi.fn(), initialTab: 'extensions' })); });
    expect(container.querySelector('[aria-label="规则设置"]')).not.toBeNull();
    expect(hooks.list).not.toHaveBeenCalled();
    await act(async () => { button('Hooks').click(); });
    expect(button('Hooks').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[aria-label="Hooks JSON 配置"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="规则设置"]')).toBeNull();
    expect(hooks.list).toHaveBeenCalledOnce();
    await act(async () => { button('规则').click(); });
    expect(container.querySelector('[aria-label="规则设置"]')).not.toBeNull();
  });

  it('mounts skill, MCP and tool trust management only on their selected subpage', async () => {
    window.amd!.agent.skills = { list: vi.fn(async () => ({ skills: [], diagnostics: [] })), openDirectory: vi.fn(), previewImport: vi.fn(), confirmImport: vi.fn(), setEnabled: vi.fn() };
    window.amd!.agent.mcp = { list: vi.fn(async () => ({ path: '/agent/mcp.json', servers: [], diagnostics: [] })), save: vi.fn(), remove: vi.fn(), test: vi.fn(), log: vi.fn() };
    window.amd!.agent.toolTrust = { get: vi.fn(async () => ({ tools: [], diagnostics: [] })), set: vi.fn() };
    await act(async () => root.render(createElement(Settings, { models: [], onClose: vi.fn(), onModelsChanged: vi.fn(), onOpenRouting: vi.fn(), initialTab: 'extensions' })));
    await act(async () => button('技能').click());
    expect(container.querySelector('[aria-label="技能设置"]')).not.toBeNull();
    expect(window.amd!.agent.skills.list).toHaveBeenCalledOnce();
    expect(window.amd!.agent.mcp.list).not.toHaveBeenCalled();
    await act(async () => button('MCP 服务器').click());
    expect(container.querySelector('[aria-label="MCP 设置"]')).not.toBeNull();
    expect(window.amd!.agent.mcp.list).toHaveBeenCalledOnce();
    await act(async () => button('工具信任').click());
    expect(container.querySelector('[aria-label="工具信任设置"]')).not.toBeNull();
    expect(window.amd!.agent.toolTrust.get).toHaveBeenCalledOnce();
  });
});
