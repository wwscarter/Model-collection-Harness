// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentActivity, ExecutionAttempt } from '../../src/core/agent/RunActivity';
import { AgentActivityList } from '../../src/renderer/components/AgentActivityList';
import { AgentGlyph } from '../../src/renderer/components/AgentGlyph';
import { ExecutionAttempts } from '../../src/renderer/components/ExecutionAttempts';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const worker = (overrides: Partial<AgentActivity> = {}): AgentActivity => ({
  id: 'worker-history', modelId: 'claude-config', modelName: 'Claude endpoint', actualModelId: 'claude-opus-5-5',
  role: 'History audit', task: '核对历史运行的模型身份。', status: 'running', content: '',
  tools: [{ id: 'read-1', toolName: 'read', status: 'running', label: 'src/main.ts' }], ...overrides,
});
const attempt = (overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt => ({
  id: 'attempt-1', index: 0, modelId: 'claude-config', modelName: 'Claude endpoint', actualModelId: 'claude-opus-5-5', status: 'failed',
  startedAt: '2026-11-11T09:28:00.000Z', durationMs: 2400, error: 'Service temporarily unavailable', ...overrides,
});
const renderAgents = async (agents: AgentActivity[]) => { await act(async () => root.render(createElement(AgentActivityList, { agents }))); };
const click = async (selector: string) => { await act(async () => container.querySelector<HTMLElement>(selector)!.click()); };

describe('conversation worker activity', () => {
  it('shows a compact identity, actual model and activity before the report is expanded', async () => {
    await renderAgents([worker()]);
    const summary = container.querySelector('summary')!;
    expect(summary.textContent).toContain('History audit');
    expect(summary.textContent).toContain('claude-opus-5-5');
    expect(summary.textContent).toContain('正在读取文件 · src/main.ts');
    expect(summary.textContent).toContain('进行中');
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('details')!.open).toBe(false);
    expect(summary.getAttribute('aria-controls')).toBe(container.querySelector('.agent-activity-detail')!.id);
    await click('summary');
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('details')!.open).toBe(true);
    expect(container.querySelector('.activity-facts')!.textContent).toContain('核对历史运行的模型身份。');
    expect(container.querySelector('[aria-label="工具调用"]')!.textContent).toContain('src/main.ts');
    expect(container.querySelector('.activity-placeholder')!.textContent).toContain('正在执行');
  });

  it('keeps an expanded worker open when its output and completion status arrive', async () => {
    await renderAgents([worker()]); await click('summary');
    await renderAgents([worker({ status: 'completed', content: 'Claude 是本轮首次执行模型。', durationMs: 1200, tools: [{ id: 'read-1', toolName: 'read', status: 'completed', label: 'src/main.ts' }] })]);
    expect(container.querySelector('details')!.open).toBe(true);
    expect(container.querySelector('summary')!.textContent).toContain('已完成');
    expect(container.querySelector('.activity-list-heading')!.textContent).toContain('1/1 已完成');
    expect(container.querySelector('[aria-label="History audit的报告"]')!.textContent).toContain('Claude 是本轮首次执行模型。');
    expect(container.querySelector('.activity-facts')!.textContent).toContain('1.2 s');
    await click('summary');
    expect(container.querySelector('details')!.open).toBe(false);
  });

  it('keeps completed, failed and cancelled reports inspectable with errors and partial output', async () => {
    await renderAgents([worker({ status: 'completed', content: '检查完成' }), worker({ id: 'worker-ui', role: 'UI audit', status: 'failed', content: '部分分析', error: '网关暂时不可用', stopReason: 'error', tools: [] }), worker({ id: 'worker-route', role: 'Route audit', status: 'cancelled', content: '', tools: [] })]);
    const rows = container.querySelectorAll('details');
    expect(rows).toHaveLength(3);
    await act(async () => rows[1].querySelector('summary')!.click());
    expect(rows[1].querySelector('summary')!.textContent).toContain('失败');
    expect(rows[1].querySelector('.activity-error')!.textContent).toBe('网关暂时不可用');
    expect(rows[1].querySelector('.agent-activity-output')!.textContent).toContain('部分分析');
    await act(async () => rows[2].querySelector('summary')!.click());
    expect(rows[2].querySelector('summary')!.textContent).toContain('已取消');
    expect(rows[2].querySelector('.activity-placeholder')!.textContent).toContain('没有返回报告');
  });

  it('keeps worker glyph identity stable across renders and distinguishes different workers', () => {
    const first = renderToStaticMarkup(createElement(AgentGlyph, { identity: 'worker-history' }));
    expect(renderToStaticMarkup(createElement(AgentGlyph, { identity: 'worker-history' }))).toBe(first);
    expect(renderToStaticMarkup(createElement(AgentGlyph, { identity: 'worker-ui' }))).not.toBe(first);
    expect(first).toContain('aria-hidden="true"');
    expect(first).not.toContain('<img');
  });
});

describe('main model attempts', () => {
  it('shows actual failed and replacement models separately from delegated workers', async () => {
    const attempts = [attempt(), attempt({ id: 'attempt-2', index: 1, modelId: 'gpt-config', modelName: 'GPT endpoint', actualModelId: 'gpt-6.1-sol', status: 'completed', durationMs: 600, reason: '首次执行失败，使用回退模型', error: undefined })];
    await act(async () => root.render(createElement(ExecutionAttempts, { attempts })));
    const summary = container.querySelector('summary')!;
    expect(summary.textContent).toContain('主模型切换');
    expect(summary.textContent).toContain('claude-opus-5-5');
    expect(summary.textContent).toContain('gpt-6.1-sol');
    expect(container.querySelector('details')!.open).toBe(false);
    await click('summary');
    expect(container.querySelector('details')!.open).toBe(true);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('.execution-attempts-detail')!.textContent).toContain('Service temporarily unavailable');
    expect(container.querySelector('.execution-attempts-detail')!.textContent).toContain('首次执行失败，使用回退模型');
    expect(container.querySelector('.execution-attempts-detail')!.textContent).toContain('2.4 s');
  });

  it('omits a single successful execution but keeps a single failure available for inspection', async () => {
    await act(async () => root.render(createElement(ExecutionAttempts, { attempts: [attempt({ status: 'completed', error: undefined })] })));
    expect(container.querySelector('details')).toBeNull();
    await act(async () => root.render(createElement(ExecutionAttempts, { attempts: [attempt()] })));
    expect(container.querySelector('summary')!.textContent).toContain('主模型执行');
    await click('summary');
    expect(container.querySelector('.activity-error')!.textContent).toContain('Service temporarily unavailable');
  });
});
