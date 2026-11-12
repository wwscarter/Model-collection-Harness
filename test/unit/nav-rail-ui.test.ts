// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavRail, type AppView } from '../../src/renderer/components/NavRail';
import { TopBar } from '../../src/renderer/components/TopBar';

let root: Root;
let container: HTMLDivElement;

const byLabel = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === label);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }),
  });
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('NavRail', () => {
  it('keeps only the three view destinations', async () => {
    const onView = vi.fn();
    await act(async () => { root.render(createElement(NavRail, { view: 'workspace' as AppView, onView, onSettings: vi.fn() })); });
    expect(byLabel('工作台')).toBeTruthy();
    expect(byLabel('运行监测')).toBeTruthy();
    expect(byLabel('运行记录')).toBeTruthy();
    expect(byLabel('收起会话列表')).toBeUndefined();
    expect(byLabel('返回工作台')).toBeUndefined();
    await act(async () => { byLabel('运行记录')!.click(); });
    expect(onView).toHaveBeenCalledWith('runs');
  });

  it('marks the active destination', async () => {
    await act(async () => { root.render(createElement(NavRail, { view: 'monitoring' as AppView, onView: vi.fn(), onSettings: vi.fn() })); });
    expect(byLabel('运行监测')?.getAttribute('aria-pressed')).toBe('true');
    expect(byLabel('工作台')?.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('TopBar', () => {
  const render = (sidebarOpen: boolean, onToggleSidebar = vi.fn()) => act(async () => {
    root.render(createElement(TopBar, {
      title: '会话标题', tabs: [], rightOpen: false, previewOpen: false,
      sidebarOpen, onToggleSidebar, onSelectTab: vi.fn(), onClosePreview: vi.fn(), onToggleRight: vi.fn(),
    }));
  });

  it('hosts the sidebar toggle in the main title bar', async () => {
    const onToggleSidebar = vi.fn();
    await render(true, onToggleSidebar);
    const toggle = byLabel('收起会话列表');
    expect(toggle).toBeTruthy();
    await act(async () => { toggle!.click(); });
    expect(onToggleSidebar).toHaveBeenCalled();
  });

  it('reflects a collapsed sidebar', async () => {
    await render(false);
    expect(byLabel('展开会话列表')).toBeTruthy();
    expect(byLabel('收起会话列表')).toBeUndefined();
  });
});
