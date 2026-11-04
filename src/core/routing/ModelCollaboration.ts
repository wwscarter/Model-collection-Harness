import { hasUsableCredentials, type ModelConfig } from '../models/ModelConfig';

const agentPerspectives = ['独立方案与实现路径', '风险、限制与失败恢复', '测试方案、验收标准与遗漏点', '替代方案与取舍比较'];

/**
 * For high-complexity work, pair the execution model with a separate reasoning
 * model that prepares a short plan. This keeps the user's task with the models
 * doing the work and does not turn the prompt into an audit target.
 */
export function selectPlanningModel(models: ModelConfig[], executionModelId: string): ModelConfig | undefined {
  return models
    .filter((model) => model.enabled && hasUsableCredentials(model) && model.id !== executionModelId)
    .filter((model) => (model.capabilities.find((capability) => capability.type === 'reasoning')?.score ?? 0) > 0)
    .sort((a, b) => {
      const score = (model: ModelConfig) =>
        (model.capabilities.find((capability) => capability.type === 'reasoning')?.score ?? 0) * 0.8 +
        (model.intelligenceScore ?? 50) * 0.2;
      return score(b) - score(a) || a.priority - b.priority || a.costPer1kTokens.input - b.costPer1kTokens.input;
    })[0];
}

export function buildPlanningPrompt(task: string): string {
  return `Create a concise execution plan for the user's task. Focus on steps, constraints, and important edge cases. Do not produce the final answer or review another model's output.\n\nUser task:\n${task}`;
}

export function buildPlannedTask(task: string, plan: string): string {
  return `${task}\n\nExecution plan from the planning model (use as guidance, verify against the task):\n${plan}`;
}

export function buildParallelAgentPrompt(task: string, index: number): string {
  const perspective = agentPerspectives[index % agentPerspectives.length];
  return `You are an independent analysis subagent. Focus on: ${perspective}. Use the available tools (such as web search) when the task needs current or external information; never claim to have used a tool you did not call, and do not modify files. Give a concise, concrete analysis that directly addresses the user's task.\n\nUser task:\n${task}`;
}

export function buildSynthesisPrompt(task: string, reports: Array<{ modelName: string; content: string }>, failedCount = 0): string {
  const reportText = reports.map((report, index) => `Subagent ${index + 1} (${report.modelName}):\n${report.content}`).join('\n\n');
  const failures = failedCount ? `\n\n${failedCount} subagent(s) failed and provided no usable report.` : '';
  return `Complete the user's task using the independent subagent reports below. Compare their conclusions, resolve disagreements, and present one clear answer. Do not claim actions that were not performed.\n\nUser task:\n${task}\n\nIndependent reports:\n${reportText}${failures}`;
}

export function runParallelAgents<TModel, TResult>(models: readonly TModel[], run: (model: TModel, index: number) => Promise<TResult>): Promise<PromiseSettledResult<TResult>[]> {
  return Promise.allSettled(models.map((model, index) => run(model, index)));
}
