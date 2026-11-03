import { createHash } from 'node:crypto';
import type { ModelProvider, InvokeConfig } from '@core/providers/ModelProvider';

export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AuditCategory = 'security' | 'performance' | 'quality' | 'logic';

export interface AuditIssue { severity: AuditSeverity; category: AuditCategory; description: string; suggestion: string; line?: number; }
export interface CodeBlock { language: string; code: string; startLine: number; endLine: number; }
export interface CodeBlockAudit extends CodeBlock { score: number; issues: AuditIssue[]; }
export interface AuditResult {
  taskId: string;
  originalModelId: string;
  auditModelId: string;
  timestamp: Date;
  overallScore: number;
  approval: boolean;
  issues: AuditIssue[];
  contentHash: string;
  codeBlocks?: CodeBlockAudit[];
  scores?: { security: number; performance: number; quality: number; logic: number };
}

export interface CodeAuditorOptions {
  /** The independent audit provider. It must not be the model that generated the content. */
  provider?: ModelProvider;
  auditModelId?: string;
  maxTokens?: number;
}

/**
 * Independent code review boundary. `auditCode` stays synchronous for the local
 * deterministic baseline; `auditCodeAsync` uses the injected audit provider when
 * one is configured and always falls back to the baseline on provider/parse errors.
 */
export class CodeAuditor {
  private readonly provider?: ModelProvider;
  private readonly auditModelId: string;
  private readonly maxTokens: number;
  private readonly staticAuditModelId = 'local-static-auditor';

  constructor(auditModelIdOrOptions: string | CodeAuditorOptions = 'local-static-auditor', provider?: ModelProvider) {
    const options = typeof auditModelIdOrOptions === 'string' ? { auditModelId: auditModelIdOrOptions, provider } : auditModelIdOrOptions;
    this.provider = options.provider;
    this.auditModelId = options.auditModelId ?? options.provider?.modelId ?? 'local-static-auditor';
    this.maxTokens = options.maxTokens ?? 4000;
  }

  /** Deterministic fallback that is safe to run offline and easy to reproduce. */
  auditCode(content: string, taskId: string, originalModelId: string): AuditResult {
    const codeBlocks = extractCodeBlocks(content);
    const issues: AuditIssue[] = [];
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/\beval\s*\(|new Function\s*\(/.test(line)) issues.push({ severity: 'high', category: 'security', description: '动态执行代码会扩大代码注入风险。', suggestion: '替换为显式解析或白名单分派。', line: index + 1 });
      if (/api[_-]?key|secret|password\s*[:=]/i.test(line) && !/process\.env|env\./i.test(line)) issues.push({ severity: 'high', category: 'security', description: '疑似硬编码凭据。', suggestion: '使用环境变量或安全凭据存储。', line: index + 1 });
      if (/console\.log\([^)]*(token|secret|password|apiKey)/i.test(line)) issues.push({ severity: 'medium', category: 'quality', description: '日志可能泄露敏感信息。', suggestion: '移除敏感字段或进行脱敏。', line: index + 1 });
      if (/\bwhile\s*\(\s*true\s*\)/.test(line)) issues.push({ severity: 'medium', category: 'performance', description: '无限循环可能造成 CPU 占用或请求阻塞。', suggestion: '添加退出条件、超时或取消信号。', line: index + 1 });
    });
    const scores = scoreIssues(issues);
    const blockAudits = codeBlocks.map((block) => ({ ...block, score: Math.max(0, scores.overall), issues: issues.filter((issue) => issue.line !== undefined && issue.line >= block.startLine && issue.line <= block.endLine) }));
    return { taskId, originalModelId, auditModelId: this.staticAuditModelId, timestamp: new Date(), overallScore: scores.overall, approval: !issues.some((issue) => issue.severity === 'critical' || issue.severity === 'high'), issues, contentHash: hashContent(content), codeBlocks: blockAudits, scores };
  }

  /** Run an independent model audit, with strict JSON validation and static fallback. */
  async auditCodeAsync(content: string, taskId: string, originalModelId: string, signal?: AbortSignal): Promise<AuditResult> {
    const fallback = () => this.auditCode(content, taskId, originalModelId);
    if (!this.provider || this.provider.modelId === originalModelId) return fallback();
    try {
      const response = await this.provider.invoke(this.buildAuditPrompt(content), { temperature: 0, maxTokens: this.maxTokens, signal });
      return this.parseProviderResult(response.content, content, taskId, originalModelId, response.modelId || this.auditModelId);
    } catch {
      return fallback();
    }
  }

  buildAuditPrompt(content: string): string {
    const blocks = extractCodeBlocks(content);
    const code = blocks.length ? blocks.map((block, index) => `\n=== Code Block ${index + 1} (${block.language}) lines ${block.startLine}-${block.endLine} ===\n${block.code}`).join('\n') : `\n=== Plain content ===\n${content}`;
    return `You are an independent senior code auditor. The generating model is not the audit model. Analyze the supplied code for security vulnerabilities (OWASP), performance, quality, maintainability, and logic errors. Return JSON only, without markdown fences, using this schema: {"issues":[{"severity":"critical|high|medium|low","category":"security|performance|quality|logic","line":0,"description":"...","suggestion":"..."}],"scores":{"security":0,"performance":0,"quality":0,"logic":0},"overallScore":0,"approval":true}. Scores must be integers from 0 to 100.\n${code}`;
  }

  private parseProviderResult(raw: string, content: string, taskId: string, originalModelId: string, auditModelId: string): AuditResult {
    const json = extractJson(raw);
    if (!json || typeof json !== 'object') throw new Error('Audit provider did not return JSON');
    const input = json as Record<string, unknown>;
    const issues = Array.isArray(input.issues) ? input.issues.map(normalizeIssue).filter((issue): issue is AuditIssue => Boolean(issue)) : [];
    const rawScores = (input.scores && typeof input.scores === 'object' ? input.scores : {}) as Record<string, unknown>;
    const scores = {
      security: boundedScore(rawScores.security),
      performance: boundedScore(rawScores.performance),
      quality: boundedScore(rawScores.quality),
      logic: boundedScore(rawScores.logic),
    };
    const suppliedOverall = boundedScore(input.overallScore);
    const overall = suppliedOverall || Math.round((scores.security + scores.performance + scores.quality + scores.logic) / 4) || Math.max(0, 100 - issues.length * 10);
    const blocks = extractCodeBlocks(content);
    return { taskId, originalModelId, auditModelId, timestamp: new Date(), overallScore: overall, approval: input.approval === undefined ? !issues.some((issue) => issue.severity === 'critical' || issue.severity === 'high') : Boolean(input.approval), issues, contentHash: hashContent(content), codeBlocks: blocks.map((block) => ({ ...block, score: overall, issues: issues.filter((issue) => issue.line !== undefined && issue.line >= block.startLine && issue.line <= block.endLine) })), scores };
  }
}

export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const regex = /```\s*([A-Za-z0-9_+.#-]*)[^\n]*\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const code = match[2].replace(/^\n+|\n+$/g, '');
    const startOffset = text.slice(0, match.index).split(/\r?\n/).length;
    const language = normalizeLanguage(match[1]);
    blocks.push({ language, code, startLine: startOffset + 1, endLine: startOffset + code.split(/\r?\n/).length });
  }
  if (!blocks.length && looksLikeCode(text)) blocks.push({ language: 'text', code: text.trim(), startLine: 1, endLine: text.split(/\r?\n/).length });
  return blocks;
}

function normalizeLanguage(value: string): string { const normalized = value.trim().toLowerCase(); return normalized || 'text'; }
function looksLikeCode(text: string): boolean { return /\b(function|class|const|let|var|import|export|def|return)\b|=>|[{};]/.test(text); }
function hashContent(content: string): string { return createHash('sha256').update(content).digest('hex'); }
function boundedScore(value: unknown): number { const score = typeof value === 'number' ? value : Number(value); return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0; }
function scoreIssues(issues: AuditIssue[]): { security: number; performance: number; quality: number; logic: number; overall: number } { const scores = { security: 100, performance: 100, quality: 100, logic: 100 }; for (const issue of issues) { const points = issue.severity === 'critical' ? 35 : issue.severity === 'high' ? 20 : issue.severity === 'medium' ? 10 : 5; scores[issue.category] = Math.max(0, scores[issue.category] - points); } return { ...scores, overall: Math.round((scores.security + scores.performance + scores.quality + scores.logic) / 4) }; }
function normalizeIssue(value: unknown): AuditIssue | undefined { if (!value || typeof value !== 'object') return undefined; const issue = value as Record<string, unknown>; const severity = issue.severity; const category = issue.category; if (!['critical', 'high', 'medium', 'low'].includes(String(severity)) || !['security', 'performance', 'quality', 'logic'].includes(String(category))) return undefined; return { severity: severity as AuditSeverity, category: category as AuditCategory, description: String(issue.description ?? '未提供描述'), suggestion: String(issue.suggestion ?? '请人工复核。'), line: typeof issue.line === 'number' && issue.line > 0 ? Math.floor(issue.line) : undefined }; }
function extractJson(raw: string): unknown { const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim(); try { return JSON.parse(stripped); } catch { const start = stripped.indexOf('{'); const end = stripped.lastIndexOf('}'); if (start < 0 || end <= start) return undefined; try { return JSON.parse(stripped.slice(start, end + 1)); } catch { return undefined; } } }

export const codeAuditor = new CodeAuditor();
