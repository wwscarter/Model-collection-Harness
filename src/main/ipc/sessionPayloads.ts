import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { RunRequest } from '@core/agent/RunCoordinator';
import type { SessionRecord } from '@core/storage/SessionStorage';

/**
 * Renderer-supplied payloads are the app's untrusted boundary. `executeRun` and
 * `SessionStorage` already validate or sanitise parts of these objects, but they
 * run after side effects (project lookup, AbortController registration, sqlite
 * writes). These schemas reject malformed values first and replace opaque
 * better-sqlite3 / type errors with a message that names the bad field.
 */

const identity = Type.String({ minLength: 1, maxLength: 300 });
const optionalIdentity = Type.Optional(identity);

const runRequestSchema = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 200_000 }),
  sessionId: optionalIdentity,
  taskId: optionalIdentity,
  runId: optionalIdentity,
  assistantMessageId: optionalIdentity,
  // null means "no project selected"; the renderer sends it explicitly.
  projectId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 2_000 }), Type.Null()])),
  operation: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('text.chat'), Type.Literal('image.generate'), Type.Literal('video.generate')])),
  textModelPreferenceId: optionalIdentity,
  pinnedModelId: optionalIdentity,
  taskType: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  complexity: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
  stream: Type.Optional(Type.Boolean()),
  collaboratorModelIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 8 })),
  contextPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 200 })),
  includeProjectContext: Type.Optional(Type.Boolean()),
  contextMaxTokens: Type.Optional(Type.Number({ minimum: 1, maximum: 2_000_000 })),
  // Turn contents are sanitised and bounded per turn in runHelpers; only the
  // array size needs a bound here so one request cannot pin an unbounded list.
  history: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 5_000 })),
  sessionRules: Type.Optional(Type.String({ maxLength: 16_000 })),
  enableTools: Type.Optional(Type.Boolean()),
  verificationMode: Type.Optional(Type.Union([Type.Literal('off'), Type.Literal('quick'), Type.Literal('full')])),
  planningMode: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('confirm'), Type.Literal('only')])),
});

/** Fields of SessionRecord that SessionStorage persists directly into typed columns. */
const sessionSaveSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.String({ maxLength: 500 }),
  prompt: Type.Optional(Type.String({ maxLength: 200_000 })),
  output: Type.Optional(Type.String({ maxLength: 4_000_000 })),
  userMessage: Type.Optional(Type.String({ maxLength: 200_000 })),
  messages: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 10_000 })),
  modelUsed: Type.Optional(Type.String({ maxLength: 300 })),
  modelId: Type.Optional(Type.String({ maxLength: 300 })),
  projectId: Type.Optional(Type.String({ maxLength: 2_000 })),
  projectRoot: Type.Optional(Type.String({ maxLength: 4_096 })),
  multiModel: Type.Optional(Type.Boolean()),
  rating: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })),
});

export function isRunRequest(value: unknown): value is RunRequest {
  return Check(runRequestSchema, value);
}

export function validateRunRequest(value: unknown): RunRequest {
  if (!isRunRequest(value)) throw new Error('任务请求格式无效：请检查 prompt、会话/项目标识以及模式字段的类型和长度');
  return value;
}

export function validateSessionRecord(value: unknown): SessionRecord {
  if (!Check(sessionSaveSchema, value)) throw new Error('会话数据格式无效：请检查 id、title、messages 等字段的类型和长度');
  const session = value as SessionRecord & { createdAt?: string | number | Date; updatedAt?: string | number | Date };
  // Invalid or missing timestamps degrade to "now" instead of failing the save:
  // losing a conversation is worse than an imprecise timestamp.
  const at = (input: unknown, fallback: Date): Date => {
    if (input instanceof Date) return Number.isNaN(input.getTime()) ? fallback : input;
    if (typeof input === 'string' || typeof input === 'number') {
      const parsed = new Date(input);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return fallback;
  };
  const now = new Date();
  return { ...session, createdAt: at(session.createdAt, now), updatedAt: at(session.updatedAt, now) };
}
