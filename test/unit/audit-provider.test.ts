import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '../../src/core/providers/ModelProvider';
import { CodeAuditor, extractCodeBlocks } from '../../src/core/audit/CodeAuditor';

const provider = (content: string, modelId = 'audit-model'): ModelProvider => ({ modelId, invoke: async () => ({ content, inputTokens: 1, outputTokens: 1, modelId }) });

describe('independent code auditor', () => {
  it('extracts fenced blocks with language and line ranges', () => {
    const blocks = extractCodeBlocks('intro\n```ts\nconst x = 1;\n```');
    expect(blocks[0]).toMatchObject({ language: 'ts', code: 'const x = 1;', startLine: 3 });
  });
  it('uses validated JSON from a distinct audit provider', async () => {
    const auditor = new CodeAuditor({ provider: provider('```json\n{"issues":[{"severity":"medium","category":"quality","line":2,"description":"too broad","suggestion":"narrow it"}],"scores":{"security":99,"performance":90,"quality":80,"logic":95},"overallScore":91}\n```') });
    const result = await auditor.auditCodeAsync('```ts\nconst value = anyThing;\n```', 'task', 'execution-model');
    expect(result.auditModelId).toBe('audit-model');
    expect(result.overallScore).toBe(91);
    expect(result.issues[0]?.category).toBe('quality');
  });
  it('falls back when the provider is the execution model or returns invalid JSON', async () => {
    const same = new CodeAuditor({ provider: provider('{"overallScore":100}', 'execution-model') });
    expect((await same.auditCodeAsync('const x = eval(input);', 'task', 'execution-model')).approval).toBe(false);
    const invalid = new CodeAuditor({ provider: provider('not json') });
    expect((await invalid.auditCodeAsync('const x = eval(input);', 'task', 'execution-model')).auditModelId).toBe('local-static-auditor');
  });
});
