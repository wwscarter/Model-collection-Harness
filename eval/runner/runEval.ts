import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createCore, type Core } from '../../src/core/bootstrap/createCore';
import { readEnvironmentModel } from '../../src/core/bootstrap/environmentModel';
import { ModelStorage } from '../../src/core/storage/ModelStorage';
import { hasUsableCredentials, type ModelConfig } from '../../src/core/models/ModelConfig';
import { getSandboxStatus } from '../../src/core/security/Sandbox';
import { loadTasks, snapshotFiles } from './tasks';
import { runCheck } from './checks';
import { writeReport } from './report';
import { startSmokeServer } from './smokeServer';
import type { EvalOptions, EvalReport, EvalSample, EvalTask } from './types';
export type { EvalOptions, EvalReport, EvalSample } from './types';

function availableModels(options: EvalOptions): { models: ModelConfig[]; selected: ModelConfig; costKnown: boolean } {
  const environment = readEnvironmentModel(process.env, ['NEWAI_EVAL', 'NEWAI']);
  const models: ModelConfig[] = [];
  const file = path.join(options.dataDir ?? path.join(os.homedir(), '.newai'), 'amd.db');
  if (fs.existsSync(file)) {
    const storage = new ModelStorage(file);
    try { models.push(...storage.getAllModels()); } finally { storage.close(); }
  }
  if (environment) models.push(environment);
  if (options.modelConfig) models.push(options.modelConfig);
  const selected = options.model ? models.find((model) => model.id === options.model) ?? models.find((model) => model.modelId === options.model)
    : options.modelConfig ?? environment ?? models.find((model) => model.enabled && hasUsableCredentials(model));
  if (!selected || !hasUsableCredentials(selected)) throw new Error('No evaluation model is configured. Select --model from --data-dir, or set NEWAI_EVAL_MODEL_ID, NEWAI_EVAL_BASE_URL, NEWAI_EVAL_API_KEY and NEWAI_EVAL_PROVIDER. Use --smoke only for synthetic framework checks.');
  const costKnown = selected !== environment || Boolean((process.env.NEWAI_EVAL_INPUT_COST_PER_1K ?? process.env.NEWAI_INPUT_COST_PER_1K) && (process.env.NEWAI_EVAL_OUTPUT_COST_PER_1K ?? process.env.NEWAI_OUTPUT_COST_PER_1K));
  return { models, selected: { ...selected, enabled: true }, costKnown };
}
async function runSample(task: EvalTask, iteration: number, options: EvalOptions, selection?: ReturnType<typeof availableModels>): Promise<EvalSample> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-eval-'));
  const projectRoot = path.join(root, 'project');
  const started = Date.now();
  const runId = randomUUID();
  const selected = selection?.selected;
  const sample: EvalSample = { taskId: task.id, tags: task.tags, model: selected ? selected.provider + '/' + selected.modelId + ' (' + selected.id + ')' : 'synthetic-smoke', ...(selected ? { modelSnapshot: { configId: selected.id, provider: selected.provider, modelId: selected.modelId, ...(selection!.costKnown ? { costPer1kTokens: { ...selected.costPer1kTokens } } : {}) } } : {}), mode: options.smoke ? 'smoke' : 'model', iteration, passed: false, durationMs: 0, toolCalls: 0, cost: null, inputTokens: null, outputTokens: null, checks: [] };
  let core: Core | undefined; let smoke: Awaited<ReturnType<typeof startSmokeServer>> | undefined;
  const timeout = AbortSignal.timeout(task.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    const original = snapshotFiles(task.fixture);
    fs.cpSync(task.fixture, projectRoot, { recursive: true, errorOnExist: true });
    if (options.smoke) smoke = await startSmokeServer(task);
    const model = smoke?.model ?? selection!.selected;
    core = await createCore({ dataDir: path.join(root, 'data'), secretKey: () => randomBytes(32), confirm: () => true, emit: () => {} }, { models: [model], persistModels: false, initializePresets: false, approvalMode: 'full', enableMcp: false });
    core.memoryStore.setAutoExtract(false);
    const result = await core.run({ runId, sessionId: randomUUID(), prompt: task.prompt, pinnedModelId: model.id, includeProjectContext: false, enableTools: true, verificationMode: 'off' }, { projectRoot, signal });
    sample.toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls.length : 0;
    sample.toolCalls = Math.max(sample.toolCalls, core.traceRecorder.getTrace(runId)?.spans.filter((span) => span.kind === 'tool').length ?? 0);
    const metrics = (result.metrics ?? {}) as Record<string, unknown>;
    let cost = typeof metrics.totalCost === 'number' ? metrics.totalCost : 0;
    if (!options.smoke) {
      sample.cost = selection!.costKnown ? cost : null;
      sample.inputTokens = typeof metrics.inputTokens === 'number' ? metrics.inputTokens : null;
      sample.outputTokens = typeof metrics.outputTokens === 'number' ? metrics.outputTokens : null;
    }
    for (const check of [...task.checks].sort((a, b) => Number(a.type === 'max-cost') - Number(b.type === 'max-cost'))) {
      if (check.type === 'max-cost' && !options.smoke && !selection!.costKnown) sample.checks.push({ type: check.type, passed: false, detail: 'Model price is not configured; cost cannot be evaluated.' });
      else {
        const checked = await runCheck(check, { projectRoot, original, answer: String(result.output ?? ''), toolCalls: sample.toolCalls, cost, signal, models: selection?.models ?? [], smoke: Boolean(options.smoke) });
        sample.checks.push(checked);
        cost += checked.usage?.cost ?? 0;
      }
    }
    const limited = ['tool_limit', 'budget_limit', 'length'].includes(String(result.stopReason));
    sample.passed = sample.checks.every((check) => check.passed) && !limited && !signal.aborted;
    if (limited) sample.error = 'Run stopped before completion: ' + result.stopReason;
  } catch (error) { sample.error = signal.aborted ? (options.signal?.aborted ? 'Evaluation cancelled' : 'Task timed out') : error instanceof Error ? error.message : String(error); }
  finally {
    const trace = core?.traceRecorder.getTrace(runId);
    if (trace) {
      sample.toolCalls = Math.max(sample.toolCalls, trace.spans.filter((span) => span.kind === 'tool').length);
      if (!options.smoke) {
        sample.cost = selection!.costKnown ? trace.run.totalCost + sample.checks.reduce((sum, check) => sum + (check.usage?.cost ?? 0), 0) : null;
        sample.inputTokens = trace.run.totalInputTokens + sample.checks.reduce((sum, check) => sum + (check.usage?.inputTokens ?? 0), 0);
        sample.outputTokens = trace.run.totalOutputTokens + sample.checks.reduce((sum, check) => sum + (check.usage?.outputTokens ?? 0), 0);
      }
    }
    const cleanup = async (action: () => unknown | Promise<unknown>) => {
      try { await action(); } catch (error) { sample.passed = false; sample.error = (sample.error ? sample.error + '; ' : '') + 'Cleanup failed: ' + (error instanceof Error ? error.message : String(error)); }
    };
    await cleanup(() => core?.dispose());
    await cleanup(() => smoke?.close());
    await cleanup(() => fs.rmSync(root, { recursive: true, force: true }));
    sample.durationMs = Date.now() - started;
  }
  return sample;
}
export async function runEval(options: EvalOptions = {}): Promise<EvalReport> {
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('Evaluation repeat must be between 1 and 20');
  const tasks = loadTasks(path.resolve(options.tasksDir ?? 'eval/tasks'), options.tags, Boolean(options.smoke));
  if (options.baseline) {
    const previous = JSON.parse(fs.readFileSync(options.baseline, 'utf8')) as EvalReport;
    if (previous.schemaVersion !== 1 || previous.mode !== (options.smoke ? 'smoke' : 'model') || !Array.isArray(previous.samples)) throw new Error('Baseline must use the same report schema and smoke/model mode');
  }
  if (!options.smoke && !getSandboxStatus().enabled) throw new Error('Real model evaluations require an available OS command sandbox: ' + getSandboxStatus().reason);
  const selection = options.smoke ? undefined : availableModels(options);
  const samples: EvalSample[] = [];
  for (const task of tasks) {
    for (let iteration = 1; iteration <= repeat; iteration++) {
      if (options.signal?.aborted) break;
      options.onProgress?.({ type: 'task-start', taskId: task.id, iteration, mode: options.smoke ? 'smoke' : 'model' });
      const sample = await runSample(task, iteration, options, selection);
      samples.push(sample);
      options.onProgress?.({ type: 'task-end', taskId: task.id, iteration, passed: sample.passed, durationMs: sample.durationMs });
    }
    if (options.signal?.aborted) break;
  }
  const report = writeReport(samples, path.resolve(options.resultsDir ?? 'eval/results'), options.smoke ? 'smoke' : 'model', options.baseline, { cancelled: options.signal?.aborted, expectedSamples: tasks.length * repeat });
  options.onProgress?.({ type: 'report', passed: report.passed, jsonPath: report.jsonPath, markdownPath: report.markdownPath });
  return report;
}
