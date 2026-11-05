import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskComplexity, TaskType } from '@core/routing/AgentRouter';
import type { LocalRoutingClassification, RoutingClassificationContext } from '@core/routing/LocalRoutingModel';

export interface RoutingObservation {
  runId: string;
  sessionId: string;
  description: string;
  priorContext?: string;
  classification: LocalRoutingClassification;
}

export interface RoutingCorrection {
  id: string;
  runId: string;
  sessionId: string;
  description: string;
  priorContext?: string;
  prediction: LocalRoutingClassification;
  expected: { taskType: TaskType; complexity: TaskComplexity };
  createdAt: string;
  source: 'user-correction';
}

export interface RoutingLearningData { version: 1; source: 'user-corrections'; samples: RoutingCorrection[]; }
export interface RoutingExample { description: string; priorContext?: string; taskType: TaskType; complexity: TaskComplexity; }

const TASK_TYPES: TaskType[] = ['code', 'reasoning', 'analysis', 'review', 'creative', 'general'];
const COMPLEXITIES: TaskComplexity[] = ['low', 'medium', 'high'];
const MAX_OBSERVATIONS = 100;
const MAX_CORRECTIONS = 500;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('分类学习数据必须是对象');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number, truncate = false): string {
  if (typeof value !== 'string' || !value.trim() || (!truncate && value.length > maximum)) throw new Error(label + '无效');
  return value.slice(0, maximum);
}

function taskType(value: unknown): TaskType {
  if (!TASK_TYPES.includes(value as TaskType)) throw new Error('任务类型无效');
  return value as TaskType;
}

function complexity(value: unknown): TaskComplexity {
  if (!COMPLEXITIES.includes(value as TaskComplexity)) throw new Error('复杂度无效');
  return value as TaskComplexity;
}

function classification(value: unknown): LocalRoutingClassification {
  const input = record(value);
  if (!['heuristic', 'ollama', 'local-model'].includes(input.backend as string)) throw new Error('分类后端无效');
  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error('分类置信度无效');
  const optionalText = (key: string, maximum: number) => input[key] === undefined ? {} : { [key]: text(input[key], key, maximum, true) };
  if (input.durationMs !== undefined && (typeof input.durationMs !== 'number' || !Number.isFinite(input.durationMs) || input.durationMs < 0)) throw new Error('分类耗时无效');
  if (input.inputTruncated !== undefined && typeof input.inputTruncated !== 'boolean') throw new Error('分类截断标记无效');
  if (input.exampleCount !== undefined && (!Number.isSafeInteger(input.exampleCount) || (input.exampleCount as number) < 0)) throw new Error('分类示例数量无效');
  return {
    taskType: taskType(input.taskType), complexity: complexity(input.complexity), confidence: input.confidence,
    rationale: typeof input.rationale === 'string' ? input.rationale.slice(0, 1000) : '',
    backend: input.backend as LocalRoutingClassification['backend'],
    ...optionalText('model', 200), ...optionalText('promptVersion', 50), ...optionalText('fallbackReason', 500),
    ...optionalText('backendVersion', 100), ...optionalText('modelDigest', 200),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs as number }),
    ...(input.inputTruncated === undefined ? {} : { inputTruncated: input.inputTruncated as boolean }),
    ...(input.exampleCount === undefined ? {} : { exampleCount: input.exampleCount as number }),
  };
}

function observation(value: unknown): RoutingObservation {
  const input = record(value);
  return {
    runId: text(input.runId, '运行 ID', 200), sessionId: text(input.sessionId, '会话 ID', 200),
    description: text(input.description, '任务描述', 8000, true),
    ...(input.priorContext === undefined || input.priorContext === '' ? {} : { priorContext: text(input.priorContext, '前文', 1500, true) }),
    classification: classification(input.classification),
  };
}

function correction(value: unknown): RoutingCorrection {
  const input = record(value);
  const predicted = observation({ ...input, classification: input.prediction });
  const expected = record(input.expected);
  if (input.source !== 'user-correction') throw new Error('分类修正来源无效');
  const createdAt = text(input.createdAt, '修正时间', 50);
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('修正时间无效');
  const { classification: prediction, ...context } = predicted;
  return {
    ...context, id: text(input.id, '样本 ID', 200), prediction,
    expected: { taskType: taskType(expected.taskType), complexity: complexity(expected.complexity) },
    createdAt, source: 'user-correction',
  };
}

function tokens(value: string): Set<string> {
  const result = new Set<string>();
  for (const part of value.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(part)) {
      if (part.length === 1) result.add(part);
      for (let index = 0; index < part.length - 1; index += 1) result.add(part.slice(index, index + 2));
    } else result.add(part);
  }
  return result;
}

/** Only explicit corrections persist text; unreviewed observations stay in bounded memory. */
export class RoutingLearningStore {
  private readonly observations = new Map<string, RoutingObservation>();
  private corrections = new Map<string, RoutingCorrection>();
  private diagnostics: string[] = [];

  constructor(private readonly file: string) {
    try {
      if (!fs.existsSync(file)) return;
      if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('分类学习文件过大');
      const input = record(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (input.version !== 1 || input.source !== 'user-corrections' || !Array.isArray(input.samples) || input.samples.length > MAX_CORRECTIONS) throw new Error('分类学习文件格式无效');
      const loaded = input.samples.map(correction);
      this.corrections = new Map(loaded.map((sample) => [sample.runId, sample]));
    } catch (error) {
      this.diagnostics = ['分类学习文件未载入：' + (error instanceof Error ? error.message : String(error))];
      // Preserve the original file until the user explicitly corrects or clears it.
    }
  }

  getDiagnostics(): string[] { return [...this.diagnostics]; }

  observe(input: RoutingObservation): void {
    const next = observation(input);
    this.observations.delete(next.runId);
    this.observations.set(next.runId, next);
    if (this.observations.size > MAX_OBSERVATIONS) this.observations.delete(this.observations.keys().next().value!);
  }

  getObservation(runId: string): { observation?: RoutingObservation; correction?: RoutingCorrection } | undefined {
    const observed = this.observations.get(runId);
    const corrected = this.corrections.get(runId);
    return observed || corrected ? structuredClone({ ...(observed ? { observation: observed } : {}), ...(corrected ? { correction: corrected } : {}) }) : undefined;
  }

  correct(input: { runId: string; taskType: TaskType; complexity: TaskComplexity }): RoutingCorrection {
    const raw = record(input);
    if (Object.keys(raw).some((key) => !['runId', 'taskType', 'complexity'].includes(key))) throw new Error('分类修正包含未知字段');
    const runId = text(raw.runId, '运行 ID', 200);
    const expected = { taskType: taskType(raw.taskType), complexity: complexity(raw.complexity) };
    const observed = this.observations.get(runId);
    if (!observed) throw new Error('当前运行的分类观测已不存在，请在本次运行后再修正');
    const { classification: prediction, ...context } = observed;
    const sample: RoutingCorrection = { ...structuredClone(context), prediction: structuredClone(prediction), expected, id: this.corrections.get(runId)?.id ?? randomUUID(), createdAt: new Date().toISOString(), source: 'user-correction' };
    const next = new Map(this.corrections);
    next.delete(runId);
    next.set(runId, sample);
    if (next.size > MAX_CORRECTIONS) next.delete(next.keys().next().value!);
    this.commit(next);
    return structuredClone(sample);
  }

  exportData(): RoutingLearningData {
    return { version: 1, source: 'user-corrections', samples: structuredClone([...this.corrections.values()]) };
  }

  getExamples(context: RoutingClassificationContext): RoutingExample[] {
    const query = tokens(context.description + '\n' + (context.priorContext ?? ''));
    const ranked = [...this.corrections.values()].map((sample, order) => {
      const terms = tokens(sample.description + '\n' + (sample.priorContext ?? ''));
      const overlap = [...query].filter((term) => terms.has(term)).length;
      const exact = sample.description === context.description ? 1 : 0;
      return { sample, order, score: exact * 2 + overlap / Math.sqrt(Math.max(1, query.size * terms.size)) };
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || b.order - a.order);
    const examples: RoutingExample[] = [];
    for (const { sample } of ranked) {
      if (examples.length >= 3) break;
      const candidate: RoutingExample = { description: sample.description.slice(0, 600), ...(sample.priorContext ? { priorContext: sample.priorContext.slice(0, 300) } : {}), ...sample.expected };
      // Bound serialized prompt growth, including metadata and escaping.
      while (JSON.stringify([...examples, candidate]).length > 1800) {
        if (candidate.priorContext) candidate.priorContext = candidate.priorContext.slice(0, -50) || undefined;
        else if (candidate.description.length > 50) candidate.description = candidate.description.slice(0, -50);
        else break;
      }
      if (JSON.stringify([...examples, candidate]).length <= 1800) examples.push(candidate);
    }
    return examples;
  }

  clear(): void {
    this.commit(new Map());
    this.observations.clear();
  }

  private commit(next: Map<string, RoutingCorrection>): void {
    const temporary = this.file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, source: 'user-corrections', samples: [...next.values()] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
      this.corrections = next;
      this.diagnostics = [];
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve write/rename diagnostics. */ }
    }
  }
}
