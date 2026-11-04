import { CodeAuditor, extractCodeBlocks } from './CodeAuditor';
import type { AuditLog } from './AuditLog';
import type { ObservabilityEngine } from '../observability/ObservabilityEngine';

export interface AuditSummary {
  passed: boolean;
  score: number;
  issueCount: number;
  auditModelId: string;
}

export interface AuditDependencies {
  auditor: Pick<CodeAuditor, 'auditCode'>;
  log: Pick<AuditLog, 'append'>;
  metrics: Pick<ObservabilityEngine, 'recordAuditResult'>;
}

/**
 * Audit an answer only when it actually contains code, then persist the result
 * in both the hash-chained log and the metrics table. Auditing must never turn
 * a finished answer into a failed task.
 */
export function auditCodeAnswer(content: string, taskId: string, modelId: string, deps: AuditDependencies): AuditSummary | undefined {
  if (!extractCodeBlocks(content).length) return undefined;
  try {
    const result = deps.auditor.auditCode(content, taskId, modelId);
    deps.log.append(result);
    deps.metrics.recordAuditResult({ taskId, modelId, approved: result.approval, score: result.overallScore });
    return { passed: result.approval, score: result.overallScore, issueCount: result.issues.length, auditModelId: result.auditModelId };
  } catch (error) {
    console.error('Code audit failed', error);
    return undefined;
  }
}
