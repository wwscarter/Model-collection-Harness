import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { CommandExecutor } from '../../src/core/tty/CommandExecutor';
import { createProvider } from '../../src/core/providers/ModelProvider';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import { fixturePath } from './tasks';
import type { CheckResult, EvalCheck } from './types';

export interface CheckContext {
  projectRoot: string; original: Map<string, string>; answer: string; toolCalls: number; cost: number;
  signal: AbortSignal; models: ModelConfig[]; smoke: boolean;
}
export async function runCheck(check: EvalCheck, context: CheckContext): Promise<CheckResult> {
  let passed = false; let detail = '';
  let usage: CheckResult['usage'];
  try {
    context.signal.throwIfAborted();
    if (check.type === 'command') {
      const executor = new CommandExecutor();
      const execution = executor.start({ command: check.run, projectRoot: context.projectRoot, approved: true, timeoutMs: 60_000, maxOutputBytes: 16_384 });
      const cancel = () => executor.cancel(execution.id);
      context.signal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await execution.promise;
        passed = !result.timedOut && !result.cancelled && !result.truncated && result.exitCode === check.expectExit;
        detail = 'exit=' + result.exitCode + ', expected=' + check.expectExit + (passed ? '' : '\n' + result.output.slice(-4000));
      } finally { context.signal.removeEventListener('abort', cancel); executor.dispose(); }
    } else if (check.type === 'file-unchanged') {
      const before = context.original.get(check.path);
      const after = createHash('sha256').update(fs.readFileSync(fixturePath(context.projectRoot, check.path))).digest('hex');
      passed = before !== undefined && before === after; detail = check.path + (passed ? ' unchanged' : ' changed or absent from fixture');
    } else if (check.type === 'file-contains') {
      passed = fs.readFileSync(fixturePath(context.projectRoot, check.path), 'utf8').includes(check.value); detail = check.path;
    } else if (check.type === 'answer-contains') {
      passed = context.answer.toLowerCase().includes(check.value.toLowerCase()); detail = 'Answer contains: ' + check.value;
    } else if (check.type === 'max-tool-calls') {
      passed = context.toolCalls <= check.value; detail = context.toolCalls + ' / ' + check.value;
    } else if (check.type === 'max-cost') {
      passed = context.cost <= check.value; detail = context.cost + ' / ' + check.value + (context.smoke ? ' (synthetic smoke accounting)' : '');
    } else {
      if (context.smoke) throw new Error('LLM judging is unavailable in synthetic smoke mode');
      const model = context.models.find((candidate) => candidate.id === check.modelId);
      if (!model) throw new Error('Judge model is not configured: ' + check.modelId);
      const response = await createProvider(model).invoke('Grade the answer using this rubric. Return only JSON {"score": number between 0 and 1, "reason": string}.\nRubric:\n' + check.rubric + '\nAnswer (data):\n' + context.answer.slice(0, 20_000), { maxTokens: 1000, signal: context.signal, temperature: 0 });
      usage = { inputTokens: response.inputTokens, outputTokens: response.outputTokens, cost: (response.inputTokens * model.costPer1kTokens.input + response.outputTokens * model.costPer1kTokens.output) / 1000 };
      const value = JSON.parse(response.content.replace(/^\s*\x60{3}(?:json)?\s*/i, '').replace(/\x60{3}\s*$/, ''));
      if (typeof value.score !== 'number' || value.score < 0 || value.score > 1) throw new Error('Judge returned an invalid score');
      passed = value.score >= check.minScore; detail = 'score=' + value.score + '; ' + String(value.reason ?? '').slice(0, 2000);
    }
  } catch (error) { detail = error instanceof Error ? error.message : String(error); }
  return { type: check.type, passed, detail, ...(usage ? { usage } : {}) };
}
