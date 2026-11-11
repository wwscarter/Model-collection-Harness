import { describe, expect, it } from 'vitest';
import type { AgentActivity, ExecutionAttempt } from '../../src/core/agent/RunActivity';
import { appendAssistantChunk, historyForModel, mergeAssistantAgents, settleAssistantActivity, updateAssistantAttribution, upsertAssistantAgentTool, preparePendingTurn, replaceLatestAssistant, restoreMessages, stripAssistantProcess, truncateHistoryAtEditedMessage, updateAssistantAgent, updateAssistantMedia, updateLatestAssistantAttribution, updateLatestAssistantContent } from '../../src/renderer/sessionMessages';

describe('session message history', () => {
  it('preserves media metadata across restoration and completion, and addresses late events by turn', () => {
    const artifact = { id: 'asset-1', kind: 'image' as const, mimeType: 'image/png', fileName: '/private/path/generated.png', modelId: 'image-model', configurationId: 'image-config', jobId: 'job-1', base64: 'secret-bytes' };
    const messages = restoreMessages({ messages: [{ id: 'a1', role: 'assistant', content: '', artifacts: [artifact] }, { id: 'a2', role: 'assistant', content: 'newer' }] });
    const updated = updateAssistantMedia(messages, { messageId: 'a1', artifacts: [artifact], job: { id: 'job-1', operation: 'image.generate', status: 'succeeded' } });
    expect(updated[0].artifacts).toHaveLength(1);
    expect(updated[0].artifacts![0]).toMatchObject({ fileName: 'generated.png' });
    expect(updated[0].artifacts![0]).not.toHaveProperty('base64');
    expect(updated[1].artifacts).toBeUndefined();
    expect(stripAssistantProcess(updated)[0].artifacts).toHaveLength(1);
    expect(historyForModel(updated)[0].content).toContain('资产 ID：asset-1');
    expect(historyForModel(updated)[0].content).not.toContain('/private/path');
  });
  it('restores a legacy session as its original user and assistant messages', () => {
    expect(restoreMessages({ title: 'Legacy title', userMessage: '', prompt: '', output: 'Legacy reply' })).toEqual([
      { id: 'legacy-user', role: 'user', content: 'Legacy title' },
      { id: 'legacy-assistant', role: 'assistant', content: 'Legacy reply' },
    ]);
  });

  it('appends streamed chunks only to the pending assistant reply', () => {
    const previous = [
      { id: 'u1', role: 'user' as const, content: 'first' },
      { id: 'a1', role: 'assistant' as const, content: 'first reply' },
      { id: 'u2', role: 'user' as const, content: 'second' },
      { id: 'a2', role: 'assistant' as const, content: '' },
    ];

    const streamed = appendAssistantChunk(appendAssistantChunk(previous, 'second '), 'reply');
    expect(streamed.map(({ content }) => content)).toEqual(['first', 'first reply', 'second', 'second reply']);
    expect(replaceLatestAssistant(streamed, 'complete reply', 'model-1').map(({ content }) => content)).toEqual(['first', 'first reply', 'second', 'complete reply']);
    expect(replaceLatestAssistant(streamed, 'complete reply', 'model-1')[3].modelUsed).toBe('model-1');
  });

  it('truncates later turns when a user edits an earlier message', () => {
    const history = [
      { id: 'u1', role: 'user' as const, content: 'first' },
      { id: 'a1', role: 'assistant' as const, content: 'first reply' },
      { id: 'u2', role: 'user' as const, content: 'second' },
      { id: 'a2', role: 'assistant' as const, content: 'second reply' },
    ];

    expect(truncateHistoryAtEditedMessage(history, 'u1', 'revised first')).toEqual([
      { id: 'u1', role: 'user', content: 'revised first' },
    ]);
    expect(truncateHistoryAtEditedMessage(history, 'missing', 'revised')).toBeUndefined();
  });

  it('starts a regenerated reply after the edited message without duplicating it', () => {
    const history = [
      { id: 'u1', role: 'user' as const, content: 'first' },
      { id: 'a1', role: 'assistant' as const, content: 'first reply' },
      { id: 'u2', role: 'user' as const, content: 'second' },
      { id: 'a2', role: 'assistant' as const, content: 'second reply' },
    ];

    expect(preparePendingTurn(history, 'new', 'revised first', 'u1')).toEqual([
      { id: 'u1', role: 'user', content: 'revised first' },
      { id: 'new-assistant', role: 'assistant', content: '' },
    ]);
  });

  it('keeps planner attribution separate from the final execution model', () => {
    const pending = preparePendingTurn([], 'turn', 'task');
    const planning = updateLatestAssistantAttribution(pending, { planningModelId: 'claude' });
    const executing = updateLatestAssistantAttribution(planning, { modelUsed: 'gpt' });
    expect(executing[1]).toMatchObject({ modelUsed: 'gpt', planningModelId: 'claude' });
    expect(updateLatestAssistantContent(executing, 'answer', 'gpt')[1]).toMatchObject({ content: 'answer', modelUsed: 'gpt', planningModelId: 'claude' });
  });

  it('updates a parallel agent message without changing the final answer', () => {
    const pending = preparePendingTurn([], 'turn', 'task', undefined, [{ id: 'claude', name: 'Claude' }, { id: 'gpt', name: 'GPT' }]);
    const withClaudeText = updateAssistantAgent(pending, 'turn-assistant', { agentId: 'turn-assistant-agent-1', status: 'running', delta: 'analysis' });
    const withGptDone = updateAssistantAgent(withClaudeText, 'turn-assistant', { agentId: 'turn-assistant-agent-2', status: 'completed', content: 'report' });
    expect(withGptDone[1].agents).toEqual([
      { id: 'turn-assistant-agent-1', modelId: 'claude', modelName: 'Claude', status: 'running', content: 'analysis' },
      { id: 'turn-assistant-agent-2', modelId: 'gpt', modelName: 'GPT', status: 'completed', content: 'report' },
    ]);
    expect(withGptDone[1].content).toBe('');
  });

  it('restores parallel agent reports with a session message', () => {
    expect(restoreMessages({ messages: [{
      id: 'a1', role: 'assistant', content: 'final', modelUsed: 'gpt', planningModelId: 'claude',
      agents: [{ id: 'agent-1', modelId: 'claude', modelName: 'Claude', status: 'completed', content: 'report' }],
    }] })).toEqual([{
      id: 'a1', role: 'assistant', content: 'final', modelUsed: 'gpt', planningModelId: 'claude',
      agents: [{ id: 'agent-1', modelId: 'claude', modelName: 'Claude', status: 'completed', content: 'report' }],
    }]);
  });
});

const startedAt = '2026-11-11T09:00:00.000Z';
const attempt = (index: number, status: ExecutionAttempt['status'] = 'running'): ExecutionAttempt => ({ id: 'attempt-' + index, index, modelId: index ? 'claude-config' : 'gpt-config', actualModelId: index ? 'claude-opus-5-5' : 'gpt-6.1-sol', modelName: index ? 'Claude' : 'GPT', status, startedAt });
const analyst = (overrides: Partial<AgentActivity> = {}): AgentActivity => ({ id: 'analyst', modelId: 'claude-config', modelName: 'Claude', actualModelId: 'claude-opus-5-5', role: 'review', task: 'Inspect the implementation', status: 'running', content: '', startedAt, ...overrides });

describe('durable conversation activity', () => {
  it('targets the owning turn and keeps actual fallback identity after late events', () => {
    const messages = [{ id: 'old', role: 'assistant' as const, content: 'previous' }, { id: 'new', role: 'assistant' as const, content: '' }];
    const started = updateAssistantAttribution(messages, { messageId: 'old', runId: 'run-old', modelUsed: 'gpt-config', actualModelId: 'gpt-6.1-sol', attempt: attempt(0) });
    const fallback = updateAssistantAttribution(started, { messageId: 'old', runId: 'run-old', modelUsed: 'claude-config', actualModelId: 'claude-opus-5-5', attempt: attempt(1, 'failed') });
    const late = updateAssistantAttribution(fallback, { messageId: 'old', runId: 'run-old', modelUsed: 'gpt-config', actualModelId: 'gpt-6.1-sol', attempt: attempt(0, 'failed') });
    expect(late[0]).toMatchObject({ modelUsed: 'claude-config', actualModelId: 'claude-opus-5-5', executionAttempts: [{ index: 0, status: 'failed' }, { index: 1, status: 'failed' }] });
    expect(late[1]).toEqual(messages[1]);
    expect(updateAssistantAttribution(late, { messageId: 'old', runId: 'wrong-run', actualModelId: 'wrong-model' })).toEqual(late);
  });

  it('keeps terminal reports and tools stable when delayed running deltas arrive', () => {
    const pending = preparePendingTurn([], 'turn', 'task');
    const running = mergeAssistantAgents(pending, 'turn-assistant', [analyst()]);
    const activeTool = upsertAssistantAgentTool(running, 'turn-assistant', 'analyst', { toolCallId: 'tool-1', toolName: 'read', status: 'running', args: { path: 'src/main.ts' } });
    const finishedTool = upsertAssistantAgentTool(activeTool, 'turn-assistant', 'analyst', { toolCallId: 'tool-1', toolName: 'read', status: 'completed', summary: 'Read file', durationMs: 25 });
    const complete = mergeAssistantAgents(finishedTool, 'turn-assistant', [analyst({ status: 'completed', content: 'Review complete', finishedAt: '2026-11-11T09:00:01.000Z', durationMs: 1000 })]);
    const duplicateFinal = mergeAssistantAgents(complete, 'turn-assistant', [analyst({ status: 'completed', content: 'Review complete' })]);
    const late = updateAssistantAgent(duplicateFinal, 'turn-assistant', { agentId: 'analyst', status: 'running', delta: 'old delta', content: 'old report' });
    const lateTool = upsertAssistantAgentTool(late, 'turn-assistant', 'analyst', { toolCallId: 'tool-1', toolName: 'read', status: 'running' });
    expect(lateTool[1].agents).toEqual([expect.objectContaining({ status: 'completed', content: 'Review complete', actualModelId: 'claude-opus-5-5', durationMs: 1000, tools: [{ id: 'tool-1', toolName: 'read', status: 'completed', label: 'src/main.ts', summary: 'Read file', durationMs: 25 }] })]);
    expect(lateTool[1].content).toBe('');
    expect(lateTool[1].tools).toBeUndefined();
  });

  it('recovers agents from final payloads and retains them after transient main tools are stripped', () => {
    const messages = mergeAssistantAgents([{ id: 'a1', role: 'assistant', content: 'Final', tools: [{ id: 'main', toolName: 'read', status: 'completed' }] }], 'a1', [analyst({ status: 'completed', content: 'Independent report', tools: [{ id: 'sub', toolName: 'web_search', status: 'completed', label: 'topic' }] })]);
    const attributed = updateAssistantAttribution(messages, { messageId: 'a1', runId: 'run-1', actualModelId: 'gpt-6.1-sol', attempt: attempt(0, 'completed') });
    const persisted = stripAssistantProcess(attributed);
    expect(persisted[0].tools).toBeUndefined();
    expect(persisted[0].agents).toHaveLength(1);
    expect(restoreMessages({ messages: persisted })).toEqual(persisted);
    expect(historyForModel(persisted)).toEqual([{ role: 'assistant', content: 'Final' }]);
  });

  it('settles only unfinished activities and never invents a completed subagent report', () => {
    const agents = [analyst(), analyst({ id: 'already-done', status: 'completed', content: 'Report', tools: [{ id: 'tool', toolName: 'find', status: 'running' }] })];
    const messages = [{ id: 'a1', role: 'assistant' as const, content: 'Final', agents, executionAttempts: [attempt(0, 'failed'), attempt(1)], tools: [{ id: 'main', toolName: 'read', status: 'running' as const }] }];
    const settled = settleAssistantActivity(messages, 'a1', 'completed');
    expect(settled[0].agents).toEqual([expect.objectContaining({ status: 'failed', error: '本轮已结束，未收到完成状态' }), expect.objectContaining({ status: 'completed', content: 'Report', tools: [{ id: 'tool', toolName: 'find', status: 'failed' }] })]);
    expect(settled[0].executionAttempts).toEqual([attempt(0, 'failed'), expect.objectContaining({ status: 'completed', finishedAt: expect.any(String) })]);
    expect(settled[0].tools![0].status).toBe('failed');
    const cancelled = settleAssistantActivity(messages, 'a1', 'cancelled', '用户取消');
    expect(cancelled[0].agents![0]).toMatchObject({ status: 'cancelled', error: '用户取消' });
    expect(cancelled[0].executionAttempts![1]).toMatchObject({ status: 'cancelled', error: '用户取消' });
    expect(cancelled[0].executionAttempts![0]).toEqual(attempt(0, 'failed'));
  });

  it('creates a child activity when its first tool event arrives before its agent event', () => {
    const messages = upsertAssistantAgentTool([{ id: 'a1', role: 'assistant', content: '' }], 'a1', 'child', { toolCallId: 'sub-tool', toolName: 'read', status: 'running', args: { path: 'README.md' } });
    const final = mergeAssistantAgents(messages, 'a1', [analyst({ id: 'child', status: 'completed', content: 'Report' })]);
    expect(final[0].agents).toEqual([expect.objectContaining({ id: 'child', modelId: 'claude-config', actualModelId: 'claude-opus-5-5', status: 'completed', tools: [{ id: 'sub-tool', toolName: 'read', status: 'running', label: 'README.md' }] })]);
  });

  it('marks only unfinished restored activities as cancelled without inventing completion times', () => {
    const endedAgent = analyst({ id: 'ended', status: 'completed', content: 'Final report', finishedAt: '2026-11-11T09:00:01.000Z', durationMs: 1000 });
    const endedAttempt = { ...attempt(0, 'failed'), finishedAt: '2026-11-11T09:00:01.000Z', durationMs: 1000, error: 'Provider unavailable' };
    const source = { messages: [{ id: 'a1', role: 'assistant', content: 'Partial answer', agents: [analyst({ tools: [{ id: 'tool', toolName: 'read', status: 'running' }] }), analyst({ id: 'queued', status: 'queued' }), endedAgent], executionAttempts: [endedAttempt, attempt(1)] }] };
    const restored = restoreMessages(source, { inactive: true })[0];
    expect(restored.agents![0]).toMatchObject({ status: 'cancelled', error: '会话已恢复，未收到本次活动完成状态', startedAt, tools: [{ id: 'tool', toolName: 'read', status: 'failed' }] });
    expect(restored.agents![0]).not.toHaveProperty('finishedAt'); expect(restored.agents![0]).not.toHaveProperty('durationMs');
    expect(restored.agents![1].status).toBe('cancelled');
    expect(restored.agents![2]).toEqual(endedAgent);
    expect(restored.executionAttempts![0]).toEqual(endedAttempt);
    expect(restored.executionAttempts![1]).toMatchObject({ status: 'cancelled', error: '会话已恢复，未收到本次活动完成状态', startedAt });
    expect(restored.executionAttempts![1]).not.toHaveProperty('finishedAt'); expect(restored.executionAttempts![1]).not.toHaveProperty('durationMs');
    const live = restoreMessages(source)[0];
    expect(live.agents![0].status).toBe('running'); expect(live.agents![0].tools![0].status).toBe('running');
    expect(live.agents![1].status).toBe('queued'); expect(live.executionAttempts![1].status).toBe('running');
  });
});
