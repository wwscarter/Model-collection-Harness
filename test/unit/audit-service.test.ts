import { describe, expect, it, vi } from 'vitest';
import { auditCodeAnswer } from '../../src/core/audit/AuditService';
import { CodeAuditor } from '../../src/core/audit/CodeAuditor';

describe('audit integration', () => {
  it('records code answers in the audit log and metrics', () => {
    const append = vi.fn();
    const recordAuditResult = vi.fn();
    const summary = auditCodeAnswer('Here is the fix:\n\n```ts\nconst x = eval(input);\n```', 'task-1', 'model-a', {
      auditor: new CodeAuditor(), log: { append }, metrics: { recordAuditResult },
    });
    expect(summary).toMatchObject({ passed: false, issueCount: 1 });
    expect(append).toHaveBeenCalledOnce();
    expect(recordAuditResult).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', modelId: 'model-a', approved: false }));
  });

  it('does not audit prose-only answers', () => {
    const append = vi.fn();
    const recordAuditResult = vi.fn();
    expect(auditCodeAnswer('你好，这是普通回答。', 'task-2', 'model-a', { auditor: new CodeAuditor(), log: { append }, metrics: { recordAuditResult } })).toBeUndefined();
    expect(append).not.toHaveBeenCalled();
    expect(recordAuditResult).not.toHaveBeenCalled();
  });

  it('keeps the answer when persistence fails', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const summary = auditCodeAnswer('```ts\nconst safe = 1;\n```', 'task-3', 'model-a', {
      auditor: new CodeAuditor(),
      log: { append: () => { throw new Error('disk full'); } },
      metrics: { recordAuditResult: () => { throw new Error('database locked'); } },
    });
    expect(summary).toBeUndefined();
    spy.mockRestore();
  });
});
