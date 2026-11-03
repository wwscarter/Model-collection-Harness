import { describe, expect, it } from 'vitest';
import { appendAssistantChunk, preparePendingTurn, replaceLatestAssistant, restoreMessages, truncateHistoryAtEditedMessage, updateAssistantAgent, updateLatestAssistantAttribution, updateLatestAssistantContent } from '../../src/renderer/sessionMessages';

describe('session message history', () => {
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
