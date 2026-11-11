import { describe, expect, it } from 'vitest';
import { validateRunRequest, validateSessionRecord } from '../../src/main/ipc/sessionPayloads';

const runPayload = {
  sessionId: 'session-1',
  taskId: 'task-1',
  runId: 'run-1',
  assistantMessageId: 'message-1',
  projectId: null,
  prompt: '整理这个项目的依赖',
  taskType: 'general',
  stream: true,
  includeProjectContext: true,
  contextMaxTokens: 8_000,
  verificationMode: 'quick',
  planningMode: 'confirm',
  sessionRules: '使用中文回答',
  textModelPreferenceId: 'model-1',
  history: [{ role: 'user', content: 'hello' }],
};

describe('validateRunRequest', () => {
  it('accepts the payload shape the renderer sends', () => {
    expect(validateRunRequest(runPayload)).toBe(runPayload);
    expect(validateRunRequest({ prompt: 'hi' })).toEqual({ prompt: 'hi' });
    expect(validateRunRequest({ ...runPayload, projectId: 'project-1', operation: 'image.generate' }).projectId).toBe('project-1');
  });

  it('rejects malformed projects, modes and oversized prompt or history', () => {
    expect(() => validateRunRequest({ prompt: 'hi', projectId: 42 })).toThrow('任务请求格式无效');
    expect(() => validateRunRequest({ prompt: 'hi', planningMode: 'sometimes' })).toThrow('任务请求格式无效');
    expect(() => validateRunRequest({ prompt: 'hi', verificationMode: 'everything' })).toThrow('任务请求格式无效');
    expect(() => validateRunRequest({ prompt: '' })).toThrow('任务请求格式无效');
    expect(() => validateRunRequest({ prompt: 'x'.repeat(200_001) })).toThrow('任务请求格式无效');
    expect(() => validateRunRequest({ prompt: 'hi', history: new Array(5_001).fill({ role: 'user', content: 'x' }) })).toThrow('任务请求格式无效');
    expect(() => validateRunRequest({ prompt: 'hi', contextPaths: new Array(201).fill('a.ts') })).toThrow('任务请求格式无效');
    expect(() => validateRunRequest(null)).toThrow('任务请求格式无效');
  });
});

describe('validateSessionRecord', () => {
  const session = { id: 'session-1', title: 'Dependency cleanup', prompt: '', output: 'done', updatedAt: new Date(), createdAt: new Date() };

  it('keeps a normal session and normalises timestamps', () => {
    const result = validateSessionRecord({ ...session, messages: [{ id: 'm1', role: 'user', content: 'hi' }], metrics: { latencyMs: 10 } });
    expect(result.id).toBe('session-1');
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.updatedAt).toBeInstanceOf(Date);
    expect(result.metrics).toEqual({ latencyMs: 10 });
  });

  it('accepts ISO strings and falls back to now for invalid timestamps instead of losing the session', () => {
    const parsed = validateSessionRecord({ ...session, createdAt: '2026-11-11T12:00:00.000Z', updatedAt: 'not-a-date' });
    expect(parsed.createdAt.toISOString()).toBe('2026-11-11T12:00:00.000Z');
    expect(parsed.updatedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(parsed.updatedAt.getTime())).toBe(false);
  });

  it('rejects values that would break the typed sqlite columns', () => {
    expect(() => validateSessionRecord({ ...session, id: 42 })).toThrow('会话数据格式无效');
    expect(() => validateSessionRecord({ id: 'session-1', prompt: '' })).toThrow('会话数据格式无效');
    expect(() => validateSessionRecord({ ...session, title: { nested: true } })).toThrow('会话数据格式无效');
    expect(() => validateSessionRecord({ ...session, messages: new Array(10_001).fill({}) })).toThrow('会话数据格式无效');
    expect(() => validateSessionRecord({ ...session, rating: 9 })).toThrow('会话数据格式无效');
    expect(() => validateSessionRecord(null)).toThrow('会话数据格式无效');
  });
});
