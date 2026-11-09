// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRoutingSettings, routingStatusLabel } from '../../src/renderer/components/ModelRoutingSettings';
import { Settings } from '../../src/renderer/pages/Settings';
import type { RoutingSettings } from '../../src/core/routing/RoutingSettings';
import type { RoutingClassifierStatus } from '../../src/core/routing/LocalRoutingModel';
import type { AmdApi } from '../../src/renderer/types';

const settings = (): RoutingSettings => ({
  version: 1,
  classifier: { mode: 'rules', baseURL: 'http://127.0.0.1:11434', model: 'qwen3:1.7b', timeoutMs: 3000, promptVersion: 'v3' },
  planning: { mode: 'auto' },
});
const status = (): RoutingClassifierStatus => ({ backend: 'heuristic', available: false });
let root: Root;
let container: HTMLDivElement;
let get: ReturnType<typeof vi.fn>;
let set: ReturnType<typeof vi.fn>;
let probe: ReturnType<typeof vi.fn>;
let modelList: ReturnType<typeof vi.fn>;
let statusChanged = vi.fn((_status: RoutingClassifierStatus) => undefined);

const select = async (label: string, value: string) => {
  await act(async () => {
    const control = container.querySelector<HTMLSelectElement>('[aria-label="' + label + '"]')!;
    control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const input = async (label: string, value: string) => {
  await act(async () => {
    const control = container.querySelector<HTMLInputElement>('[aria-label="' + label + '"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes(label))!;
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const render = async () => { await act(async () => { root.render(createElement(ModelRoutingSettings, { onRoutingStatusChange: statusChanged })); }); };
const submit = async () => { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  get = vi.fn(async () => ({ settings: settings(), status: status() }));
  statusChanged = vi.fn();
  set = vi.fn(async (saved: RoutingSettings) => ({ settings: saved, status: status() }));
  probe = vi.fn(async () => ({ status: { backend: 'ollama', available: true, reachable: true, modelInstalled: true, loaded: false }, models: ['local-router', 'another-router'] }));
  modelList = vi.fn(async () => [
    { id: 'deepseek', name: 'DeepSeek', modelId: 'deepseek-chat', provider: 'deepseek', enabled: true, hasApiKey: true },
    { id: 'other', name: 'Other model', modelId: 'other-chat', provider: 'custom', enabled: true },
    { id: 'disabled', name: 'Disabled model', modelId: 'disabled', provider: 'custom', enabled: false },
    { id: 'keyless', name: 'No credentials', modelId: 'keyless', provider: 'openai', enabled: true, hasApiKey: false },
  ]);
  window.amd = { routingConfig: { get, set, probe }, routingStatus: vi.fn(async () => status()), models: { list: modelList } } as unknown as AmdApi;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove(); delete window.amd;
});

describe('model routing settings', () => {
  it('saves the default plan execution preference', async () => {
    await render();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="计划执行方式"]')!.value).toBe('auto');
    await select('计划执行方式', 'confirm');
    await submit();
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ planning: expect.objectContaining({ executionMode: 'confirm' }) }));
  });
  it('offers the shared Pi adapter by default and saves the legacy compatibility fallback', async () => {
    await render();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="辅助模型调用通道"]')!.value).toBe('pi');
    await select('辅助模型调用通道', 'legacy');
    await submit();
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ legacyProviders: true }));
    await select('辅助模型调用通道', 'pi');
    await submit();
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ legacyProviders: false }));
  });
  it('prevents saving a failed initial read and allows a retry without replacing stored settings', async () => {
    get.mockRejectedValueOnce(new Error('配置读取失败'));
    await render();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('配置读取失败');
    expect(container.querySelector('[type="submit"]')).toBeNull();
    expect(set).not.toHaveBeenCalled();
    await click('重新读取');
    expect(get).toHaveBeenCalledTimes(2);
    expect(button('保存路由设置').disabled).toBe(true);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="任务分类方式"]')!.value).toBe('rules');
    expect(container.textContent).toContain('关键词规则就绪');
  });

  it('tests the unsaved local endpoint and selected model without persisting or changing the draft', async () => {
    await render();
    await select('任务分类方式', 'ollama');
    await input('本机 Ollama 地址', 'http://127.0.0.2:11434');
    await input('分类模型 ID', 'local-router');
    await click('检测服务与模型');
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ classifier: expect.objectContaining({ mode: 'ollama', baseURL: 'http://127.0.0.2:11434', model: 'local-router' }) }));
    expect(set).not.toHaveBeenCalled();
    expect(statusChanged).not.toHaveBeenCalled();
    expect(container.textContent).toContain('草稿尚未保存');
    expect(container.querySelector('[aria-label="分类服务状态"]')!.textContent).toContain('草稿检测');
    expect(container.querySelector('[aria-label="分类服务状态"]')!.textContent).toContain('尚未加载');
    expect([...container.querySelectorAll('datalist option')].map((item) => item.getAttribute('value'))).toEqual(['local-router', 'another-router']);
    await input('分类模型 ID', 'another-router');
    expect(container.querySelector('[aria-label="分类服务状态"]')!.textContent).toContain('已保存配置');
    expect(container.querySelectorAll('datalist option')).toHaveLength(2);
    await input('本机 Ollama 地址', 'http://localhost:11434');
    expect(container.querySelector('datalist option')).toBeNull();
    expect(button('保存路由设置').disabled).toBe(false);
  });

  it('preserves the draft after a save failure and only marks a successful save as active', async () => {
    await render();
    await select('任务分类方式', 'ollama');
    await input('分类等待上限（毫秒）', '4000');
    await select('规划模型', 'other');
    await select('摘要与归档辅助模型', 'deepseek');
    set.mockRejectedValueOnce(new Error('磁盘已满'));
    await submit();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('磁盘已满');
    expect(container.querySelector<HTMLInputElement>('[aria-label="分类等待上限（毫秒）"]')!.value).toBe('4000');
    expect(button('保存路由设置').disabled).toBe(false);
    expect(container.querySelector('[aria-label="分类服务状态"]')!.textContent).toContain('关键词规则就绪');
    expect(statusChanged).not.toHaveBeenCalled();
    set.mockImplementationOnce(async (saved: RoutingSettings) => ({ settings: saved, status: { backend: 'ollama', available: false, configured: true } }));
    await submit();
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({
      classifier: expect.objectContaining({ mode: 'ollama', timeoutMs: 4000 }),
      planning: { mode: 'auto', modelId: 'other' }, utilityModelId: 'deepseek',
    }));
    expect(container.textContent).toContain('从下一轮任务生效');
    expect(container.querySelector('[aria-label="分类服务状态"]')!.textContent).toContain('尚未验证');
    expect(button('保存路由设置').disabled).toBe(true);
    expect(statusChanged).toHaveBeenCalledExactlyOnceWith({ backend: 'ollama', available: false, configured: true });
  });

  it('keeps a saved unavailable role and only offers enabled models with usable credentials', async () => {
    get.mockResolvedValueOnce({ settings: { ...settings(), planning: { mode: 'auto', modelId: 'removed-model' } }, status: status() });
    await render();
    const planner = container.querySelector<HTMLSelectElement>('[aria-label="规划模型"]')!;
    expect(planner.value).toBe('removed-model');
    expect([...planner.options].map((item) => item.value)).toEqual(['', 'removed-model', 'deepseek', 'other']);
    await select('任务规划', 'off');
    expect(planner.disabled).toBe(true);
    await submit();
    expect(set.mock.calls[0][0].planning).toEqual({ mode: 'off', modelId: 'removed-model' });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('refreshes saved service status without replacing an unsaved form', async () => {
    await render();
    await select('任务分类方式', 'ollama');
    await input('分类模型 ID', 'next-router');
    vi.mocked(window.amd!.routingStatus).mockResolvedValueOnce({ backend: 'ollama', available: true, loaded: true, modelInstalled: true, reachable: true });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="刷新分类服务状态"]')!.click(); });
    expect(container.querySelector('[aria-label="分类服务状态"]')!.textContent).toContain('已加载');
    expect(container.querySelector<HTMLInputElement>('[aria-label="分类模型 ID"]')!.value).toBe('next-router');
    expect(button('保存路由设置').disabled).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(statusChanged).toHaveBeenCalledExactlyOnceWith({ backend: 'ollama', available: true, loaded: true, modelInstalled: true, reachable: true });
  });

  it('reports offline and missing models as unavailable rather than running', () => {
    expect(routingStatusLabel({ backend: 'ollama', available: false, reachable: false })).toContain('无法连接');
    expect(routingStatusLabel({ backend: 'ollama', available: false, reachable: true, modelInstalled: false })).toContain('尚未安装');
    expect(routingStatusLabel({ backend: 'ollama', available: false, warmingUp: true })).toContain('正在预热');
    expect(routingStatusLabel({ backend: 'ollama', available: true, loaded: true })).toBe('本地分类模型已加载');
  });

  it('updates the model-tab footer after saving the classifier in the runtime tab', async () => {
    set.mockImplementationOnce(async (saved: RoutingSettings) => ({ settings: saved, status: { backend: 'ollama', available: true, loaded: false, reachable: true, modelInstalled: true } }));
    await act(async () => { root.render(createElement(Settings, { models: [], onClose: vi.fn(), onModelsChanged: vi.fn(), onOpenRouting: vi.fn() })); });
    expect(container.querySelector('.endpoint-list-foot')!.textContent).toContain('关键词规则就绪');
    await click('运行与权限');
    await select('任务分类方式', 'ollama'); await submit();
    await click('模型与端点');
    expect(container.querySelector('.endpoint-list-foot')!.textContent).toContain('本地分类模型可用，尚未加载');
    expect(container.querySelector('.endpoint-list-foot')!.textContent).not.toContain('关键词规则就绪');
  });

  it('loads legacy budget defaults and saves USD and minute inputs in the shared settings', async () => {
    await render();
    expect(container.querySelector<HTMLInputElement>('[aria-label="每轮预估费用上限（USD）"]')!.value).toBe('0.25');
    expect(container.querySelector<HTMLInputElement>('[aria-label="最长运行时间（分钟）"]')!.value).toBe('10');
    expect(button('保存路由设置').disabled).toBe(true);
    await input('每轮预估费用上限（USD）', '1.5');
    await input('最长运行时间（分钟）', '25');
    expect(set).not.toHaveBeenCalled();
    await submit();
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ budget: { maxCostUsd: 1.5, maxDurationMs: 1_500_000 } }));
    expect(container.textContent).toContain('与供应商账单可能不同');
    expect(container.textContent).toContain('单次请求结束时可能超过估算上限');
  });

  it('explains unchanged preset rates on an edited model without changing prices', async () => {
    const migrated = { id: 'openai-gpt-4-turbo', provider: 'custom', name: 'Migrated endpoint', modelId: 'different-upstream', enabled: true, priority: 0, capabilities: [], costPer1kTokens: { input: 0.01, output: 0.03 } };
    await act(async () => { root.render(createElement(Settings, { models: [migrated], onClose: vi.fn(), onModelsChanged: vi.fn(), onOpenRouting: vi.fn() })); });
    expect(container.querySelector('.settings-pricing-diagnostic')!.textContent).toContain('当前配置沿用旧预设费率');
    expect(container.querySelector('.settings-pricing-diagnostic')!.textContent).toContain('不代表已确认费率错误');
    const inputPrice = [...container.querySelectorAll<HTMLLabelElement>('label')].find((label) => label.textContent?.includes('输入价格 / 1K Token'))!.querySelector<HTMLInputElement>('input')!;
    expect(inputPrice.value).toBe('0.01');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputPrice, '0.02');
      inputPrice.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('.settings-pricing-diagnostic')).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });
});
