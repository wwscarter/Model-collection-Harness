import type { ModelConfig } from '@core/models/ModelConfig';
import { createProvider, type ModelProvider } from '@core/providers/ModelProvider';
import { CodeAuditor, extractCodeBlocks, type AuditResult } from '@core/audit/CodeAuditor';

export interface VerificationInput {
  content: string;
  taskId: string;
  executionModelId: string;
  model: ModelConfig;
  signal?: AbortSignal;
  /** Test seam; production uses the configured provider. */
  provider?: ModelProvider;
}

export interface VerificationOutput {
  audit: AuditResult;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export function hasCode(content: string): boolean {
  return extractCodeBlocks(content).length > 0;
}

export function shouldRevise(audit: AuditResult): boolean {
  return !audit.approval || audit.issues.some((issue) => issue.severity === 'critical' || issue.severity === 'high');
}

/**
 * Run an independent model audit on a code answer. CodeAuditor falls back to
 * its deterministic rules on provider/JSON errors, so verification itself never
 * blocks the answer. Usage is captured for the run trace and cost budget.
 */
export async function verifyCodeAnswer(input: VerificationInput): Promise<VerificationOutput | undefined> {
  if (!hasCode(input.content)) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  const provider = input.provider ?? createProvider(input.model);
  const wrapped: ModelProvider = {
    modelId: input.model.id,
    invoke: async (prompt, config) => {
      const response = await provider.invoke(prompt, config);
      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;
      return response;
    },
  };
  const auditor = new CodeAuditor({ provider: wrapped, auditModelId: input.model.id, maxTokens: 2_000 });
  const audit = await auditor.auditCodeAsync(input.content, input.taskId, input.executionModelId, input.signal);
  const cost = (inputTokens * input.model.costPer1kTokens.input + outputTokens * input.model.costPer1kTokens.output) / 1000;
  return { audit, inputTokens, outputTokens, cost };
}

export function buildRevisionPrompt(task: string, previous: string, audit: AuditResult): string {
  const issues = audit.issues.slice(0, 8).map((issue) => `- [${issue.severity}/${issue.category}] ${issue.description} → ${issue.suggestion}`).join('\n') || '- 审计未通过，请重新检查正确性与安全性。';
  return [
    'Revise the answer below after an independent audit. Return the complete revised answer only, with the same user-facing language.',
    'Do not mention the audit process, do not claim tools were used, and do not add unrelated content.',
    '',
    `Original task:\n${task}`,
    '',
    `Previous answer:\n${previous.slice(0, 20_000)}`,
    '',
    `Audit issues:\n${issues}`,
  ].join('\n');
}
