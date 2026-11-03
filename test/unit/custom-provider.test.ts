import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { createProvider, resolveOpenAIEndpoint } from '../../src/core/providers/ModelProvider';

function customModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'local-openai',
    provider: 'custom',
    name: 'Local OpenAI-compatible service',
    apiKey: '',
    baseURL: 'http://127.0.0.1:8080/v1',
    modelId: 'local-model',
    costPer1kTokens: { input: 0, output: 0 },
    capabilities: [],
    maxTokens: 2048,
    rateLimit: { requestsPerMinute: 0, tokensPerDay: 0 },
    enabled: true,
    priority: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('custom OpenAI-compatible provider', () => {
  it('normalizes a base URL and a full endpoint', () => {
    expect(resolveOpenAIEndpoint('https://gateway.example/v1/')).toBe('https://gateway.example/v1/chat/completions');
    expect(resolveOpenAIEndpoint('https://gateway.example/v1/chat/completions')).toBe('https://gateway.example/v1/chat/completions');
    expect(resolveOpenAIEndpoint('https://gateway.example/v1?tenant=demo')).toBe('https://gateway.example/v1/chat/completions?tenant=demo');
    expect(resolveOpenAIEndpoint('https://gateway.example/v1/chat/completions?tenant=demo')).toBe('https://gateway.example/v1/chat/completions?tenant=demo');
  });

  it('calls a custom endpoint without an API key or Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'connected' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createProvider(customModel()).invoke('ping');

    expect(result.content).toBe('connected');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }));
  });
});
