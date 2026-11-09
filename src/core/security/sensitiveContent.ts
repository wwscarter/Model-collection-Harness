/** Shared credential heuristics, extracted from the existing memory-store filter. */
const PATTERNS = [
  /sk-[a-z0-9_-]{16,}/i,
  /api[_-]?key\s*[:=]/i,
  /BEGIN (?:(?:RSA|OPENSSH|EC) )?PRIVATE KEY/i,
  /AKIA[0-9A-Z]{16}/i,
  /ghp_[a-z0-9]{20,}/i,
  /xox[baprs]-/i,
];

/** Returns no matching text, so diagnostics never repeat a possible credential. */
export function containsSensitiveContent(content: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(content));
}
export const hasSensitiveContent = containsSensitiveContent;
