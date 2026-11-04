import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '../../src/core/providers/ModelProvider';
import { CodeAuditor, extractCodeBlocks } from '../../src/core/audit/CodeAuditor';

const provider = (content: string, modelId = 'audit-model'): ModelProvider => ({ modelId, invoke: async () => ({ content, inputTokens: 1, outputTokens: 1, modelId }) });

describe('independent code auditor', () => {
  it('keeps the first line of unlabelled code fences and preserves blank-line offsets', () => {
    const blocks = extractCodeBlocks('Intro\n```\nconst first = 1;\nconst second = 2;\n```\n```ts\n\nconst third = 3;\n```');
    expect(blocks[0]).toMatchObject({ language: 'text', code: 'const first = 1;\nconst second = 2;', startLine: 3, endLine: 4 });
    expect(blocks[1]).toMatchObject({ code: '\nconst third = 3;', startLine: 7, endLine: 8 });
    expect(extractCodeBlocks('\n\nconst plain = 1;')[0]).toMatchObject({ code: '\n\nconst plain = 1;', startLine: 1, endLine: 3 });
  });

  it('audits code blocks without treating surrounding explanation as source code', () => {
    const result = new CodeAuditor().auditCode('Keep the API key and secret outside this file.\n```ts\nconst count = 1;\n```', 'task', 'model');
    expect(result.approval).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('preserves zero scores and refuses approval when high-severity logic issues exist', async () => {
    const auditor = new CodeAuditor({ provider: provider(JSON.stringify({
      issues: [{ severity: 'high', category: 'logic', description: 'The result is incorrect', suggestion: 'Correct the calculation' }],
      scores: { security: 0, performance: 0, quality: 0, logic: 0 }, overallScore: 0, approval: true,
    })) });
    const result = await auditor.auditCodeAsync('const answer = 1;', 'task', 'executor');
    expect(result).toMatchObject({ auditModelId: 'audit-model', overallScore: 0, approval: false });
    expect(result.scores?.logic).toBe(0);
  });

  it.each(['{}', '{"issues":[],"approval":"false"}', '{"issues":[{"severity":"unknown"}]}'])('falls back for structurally invalid audit results: %s', async (content) => {
    const auditor = new CodeAuditor({ provider: provider(content) });
    expect((await auditor.auditCodeAsync('const answer = 1;', 'task', 'executor')).auditModelId).toBe('local-static-auditor');
  });

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
