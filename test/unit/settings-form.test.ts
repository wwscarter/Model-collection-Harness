import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/renderer/types';
import { createSettingsDraft, settingsPayload } from '../../src/renderer/settingsForm';

const model: ModelConfig = {
  id: 'deepseek-main', name: 'DeepSeek Main', provider: 'deepseek', providerCategory: 'official',
  baseURL: 'https://api.deepseek.com/v1', modelId: 'deepseek-reasoner',
  availableModels: ['deepseek-reasoner', 'deepseek-chat'], temperature: 0.6,
  enableThinking: true, isPrimary: true, apiKey: '', hasApiKey: true, enabled: true, priority: 1,
  contextWindow: 64000, maxTokens: 4096, capabilities: [{ type: 'reasoning', score: 92 }],
  costPer1kTokens: { input: 0.01, output: 0.02 },
  rateLimit: { requestsPerMinute: 60, tokensPerDay: 100000 },
};

describe('settings form draft', () => {
  it('loads the saved model and its inference settings without exposing a saved credential', () => {
    const draft = createSettingsDraft(model);

    expect(draft).toMatchObject({
      provider: 'deepseek', providerCategory: 'official', modelId: 'deepseek-reasoner',
      availableModels: ['deepseek-reasoner', 'deepseek-chat'], temperature: 0.6,
      contextWindow: '64000', enableThinking: true, primary: true,
    });
    expect(draft.apiKey).toBe('');
  });

  it('keeps the encrypted credential when editing with an empty key field', () => {
    const draft = createSettingsDraft(model);
    draft.temperature = 1.2;
    draft.availableModels.push('deepseek-coder');

    const payload = settingsPayload(draft, true);

    expect(payload).not.toHaveProperty('apiKey');
    expect(payload).toMatchObject({
      modelId: 'deepseek-reasoner', availableModels: ['deepseek-reasoner', 'deepseek-chat', 'deepseek-coder'],
      temperature: 1.2, enableThinking: true, contextWindow: 64000,
    });
  });

  it('includes a new credential when adding a model', () => {
    const draft = createSettingsDraft();
    Object.assign(draft, {
      name: 'Gateway', provider: 'custom', providerCategory: 'compatible_gateway',
      baseURL: 'https://gateway.example/v1', apiKey: 'sk-new', modelId: 'gateway-chat',
      availableModels: ['gateway-chat'],
    });

    expect(settingsPayload(draft, false)).toMatchObject({ apiKey: 'sk-new', modelId: 'gateway-chat' });
  });

  it('normalizes whitespace in credentials and preserves an existing key for blank edits', () => {
    const draft = createSettingsDraft(model);
    draft.apiKey = '   ';
    expect(settingsPayload(draft, true)).not.toHaveProperty('apiKey');
    draft.apiKey = '  sk-replacement  ';
    expect(settingsPayload(draft, true).apiKey).toBe('sk-replacement');
  });

  it('saves the primary choice with the rest of the configuration in one payload', () => {
    const draft = createSettingsDraft(model);
    draft.primary = true;
    draft.enabled = false;
    expect(settingsPayload(draft, true)).toMatchObject({ isPrimary: true, enabled: true });
    draft.primary = false;
    expect(settingsPayload(draft, true)).toMatchObject({ isPrimary: false, enabled: false });
  });

  it('rejects Anthropic temperature above its provider limit', () => {
    const draft = createSettingsDraft({ ...model, provider: 'anthropic' });
    draft.temperature = 1.1;
    expect(() => settingsPayload(draft, true)).toThrow('1.0');
  });

  it.each([
    { contextWindow: '0', message: '上下文窗口' },
    { contextWindow: '2048', maxTokens: '4096', message: '最大输出 Token' },
    { temperature: 1.6, message: '采样温度' },
    { baseURL: 'file:///tmp/credentials', message: 'http 或 https' },
  ])('rejects invalid settings before save', ({ message, ...updates }) => {
    const draft = createSettingsDraft(model);
    Object.assign(draft, updates);

    expect(() => settingsPayload(draft, true)).toThrow(message);
  });
});
