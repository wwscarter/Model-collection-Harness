// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../../src/renderer/components/Sidebar';
import { Settings } from '../../src/renderer/pages/Settings';
import type { AmdApi, ModelConfig } from '../../src/renderer/types';

let container: HTMLDivElement;
let root: Root;
const model: ModelConfig = { id: 'endpoint', name: 'Local endpoint', modelId: 'chosen-model', provider: 'custom', enabled: true, availableModels: ['chosen-model', 'another-model'], capabilities: [], priority: 0, costPer1kTokens: { input: 0, output: 0 }, baseURL: 'http://127.0.0.1:1234/v1', temperature: 0.6, contextWindow: 64000 };
const render = async (element: React.ReactNode) => { await act(async () => { root.render(element); }); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.amd = { routingStatus: vi.fn(async () => ({ backend: 'heuristic', available: true })), models: { fetchModels: vi.fn(async () => ({ models: ['chosen-model', 'fetched-model'] })) } } as unknown as AmdApi;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); delete window.amd; });

describe('list decoration controls', () => {
  it('keeps project and conversation navigation without section-count badges', async () => {
    const onOpenProject = vi.fn(), onSelectSession = vi.fn();
    await render(createElement(Sidebar, {
      projects: [{ id: 'p1', name: 'Sample project', root: '/sample', displayRoot: '/sample', active: false, createdAt: new Date(), lastOpenedAt: new Date() }],
      sessions: [{ id: 's1', title: 'Sample conversation', createdAt: new Date() }], currentSessionId: 's1', runningSessionId: null,
      onNewSession: vi.fn(), onDeleteSession: vi.fn(), onNewProject: vi.fn(), onRemoveProject: vi.fn(), onOpenProject, onSelectSession,
    }));
    expect(container.querySelector('.count-pill')).toBeNull();
    expect([...container.querySelectorAll('.group-toggle')].map((item) => item.textContent)).toEqual(['本地项目', '最近会话']);
    await act(async () => { container.querySelector<HTMLButtonElement>('.project-item .item-main')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('.session-item .item-main')!.click(); });
    expect(onOpenProject).toHaveBeenCalledWith('p1'); expect(onSelectSession).toHaveBeenCalledWith('s1');
  });

  it('removes decorative configuration totals and Esc text while retaining both close actions and numeric inputs', async () => {
    const onClose = vi.fn();
    await render(createElement(Settings, { models: [model], onClose, onModelsChanged: vi.fn(), onOpenRouting: vi.fn() }));
    expect(container.querySelector('.count-pill, .endpoint-ready-count, .endpoint-model-count, .kbd-hint')).toBeNull();
    expect(container.querySelector('.settings-titlebar')!.textContent).not.toContain('Esc');
    expect(container.querySelector('.model-sync-status')!.textContent).toBe('已配置');
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe('0.6');
    expect(container.querySelector('.context-presets')!.textContent).toContain('64k');
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click(); });
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('still fetches and selects models without adding a result-count label', async () => {
    await render(createElement(Settings, { models: [model], onClose: vi.fn(), onModelsChanged: vi.fn(), onOpenRouting: vi.fn() }));
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes('获取模型 (Fetch Models)'))!.click(); });
    expect(window.amd!.models.fetchModels).toHaveBeenCalledOnce();
    expect(container.querySelector('.settings-notice')!.textContent).toContain('已从端点获取模型列表');
    expect(container.querySelector('.settings-notice')!.textContent).not.toMatch(/\d+ 个模型/);
    expect(container.querySelector('.model-sync-status')!.textContent).toBe('已从 API 获取');
    expect([...container.querySelectorAll('.model-card-title strong')].map((item) => item.textContent)).toEqual(['chosen-model', 'fetched-model']);
  });
});
