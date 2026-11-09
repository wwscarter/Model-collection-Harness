import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PlanController } from './PlanController';
import type { RunPlan } from './PlanTypes';

export function createPlanTool(plans: PlanController, runId: string, publish: (plan: RunPlan) => void): ToolDefinition {
  return defineTool({
    name: 'update_plan', label: '更新计划进度', description: 'Report progress for an existing execution-plan step. Changes status only; keep step ids and content unchanged. Mark only work actually completed as done.',
    parameters: Type.Object({ stepId: Type.String({ minLength: 1, maxLength: 60 }), status: Type.Union([Type.Literal('pending'), Type.Literal('running'), Type.Literal('done'), Type.Literal('skipped')]) }),
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const result = plans.updateStep(runId, input.stepId, input.status, publish);
      return { content: [{ type: 'text', text: '计划步骤状态已更新：' + input.stepId + ' → ' + input.status }], details: { version: result.version } };
    },
  }) as unknown as ToolDefinition;
}
