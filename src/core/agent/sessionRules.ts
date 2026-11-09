import { containsSensitiveContent } from '@core/security/sensitiveContent';

export const MAX_SESSION_RULE_CHARS = 8_000;

/** Temporary instructions are request data, never part of the stored conversation. */
export function validateSessionRules(value: unknown): asserts value is string | undefined {
  if (value !== undefined && typeof value !== 'string') throw new Error('会话规则必须是文本');
  if (typeof value === 'string' && value.length > MAX_SESSION_RULE_CHARS) throw new Error('会话规则不能超过 8000 字符');
  if (typeof value === 'string' && containsSensitiveContent(value)) throw new Error('会话规则可能包含密钥或令牌，已拒绝加载');
}
