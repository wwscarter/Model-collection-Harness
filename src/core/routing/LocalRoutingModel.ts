import fs from 'node:fs';
import type { TaskComplexity, TaskContext, TaskType } from './AgentRouter';

/**
 * A small, dependency-free local routing model.
 *
 * The roadmap calls for a Pi-Small/TinyLlama style local classifier.  The
 * application must still start on a clean install where a GGUF file and a
 * native llama runtime are not present, so this adapter deliberately keeps a
 * deterministic lexical backend as its baseline.  A future local runtime can
 * be attached through `complete` without changing the router contract.
 */
export interface LocalRoutingClassification {
  taskType: TaskType;
  complexity: TaskComplexity;
  confidence: number;
  rationale: string;
  backend: 'heuristic' | 'ollama' | 'local-model';
  model?: string;
  promptVersion?: string;
  durationMs?: number;
  fallbackReason?: string;
  inputTruncated?: boolean;
  exampleCount?: number;
  backendVersion?: string;
  modelDigest?: string;
}

export interface RoutingConfirmedExample {
  description: string;
  priorContext?: string;
  taskType: TaskType;
  complexity: TaskComplexity;
}
export interface RoutingClassificationContext extends Pick<TaskContext, 'description' | 'type' | 'complexity'> {
  priorContext?: string;
  confirmedExamples?: RoutingConfirmedExample[];
}
export interface RoutingClassificationOptions { signal?: AbortSignal; }
export interface RoutingClassifierStatus {
  backend: LocalRoutingClassification['backend'];
  available: boolean;
  modelPath?: string;
  configured?: boolean;
  reachable?: boolean;
  model?: string;
  modelInstalled?: boolean;
  loaded?: boolean;
  warmingUp?: boolean;
  lastError?: string;
  lastLatencyMs?: number;
  promptVersion?: string;
  circuitOpenUntil?: number;
  backendVersion?: string;
  modelDigest?: string;
}
export interface RoutingClassifier {
  classify(context: RoutingClassificationContext, options?: RoutingClassificationOptions): Promise<LocalRoutingClassification>;
  getStatus(): RoutingClassifierStatus;
}

export interface LocalRoutingModelOptions {
  /** Optional GGUF path, used for diagnostics and future native backends. */
  modelPath?: string;
  classifier?: RoutingClassifier;
  /** Optional completion adapter returning a JSON classification. */
  complete?: (prompt: string, options?: RoutingClassificationOptions) => Promise<string>;
}

const TASK_KEYWORDS: Array<{ type: Exclude<TaskType, 'general'>; words: string[] }> = [
  { type: 'code', words: ['code', '代码', 'bug', 'debug', '实现', '编程', 'typescript', 'javascript', 'python', 'sql', 'api', '函数', 'class'] },
  { type: 'review', words: ['review', '审查', 'audit', '审计', '漏洞', '安全', '检查代码'] },
  { type: 'analysis', words: ['分析', '数据', 'analy', 'compare', '比较', '总结', '统计', '指标'] },
  { type: 'reasoning', words: ['reason', '推理', '证明', '规划', '方案', '为什么', '因果', '决策'] },
  { type: 'creative', words: ['创意', '写作', '文案', '故事', 'creative', 'design', '设计', '命名'] },
];

const COMPLEXITY_KEYWORDS: Record<TaskComplexity, string[]> = {
  low: ['简单', 'quick', 'short', 'small', '简单地', 'one line'],
  medium: ['普通', 'normal', '一般', 'moderate'],
  high: ['复杂', '架构', '重构', '全面', '系统', '生产', 'production', '复杂度', '多步骤', 'large'],
};

export class LocalRoutingModel implements RoutingClassifier {
  readonly modelPath?: string;
  readonly backend: LocalRoutingClassification['backend'];

  constructor(private readonly options: LocalRoutingModelOptions = {}) {
    this.modelPath = options.modelPath;
    this.backend = options.classifier?.getStatus().backend ?? (options.complete ? 'local-model' : 'heuristic');
  }

  getStatus(): RoutingClassifierStatus {
    if (this.options.classifier) return this.options.classifier.getStatus();
    return {
      backend: this.backend,
      modelPath: this.modelPath,
      available: Boolean(this.options.complete) || Boolean(this.modelPath && fs.existsSync(this.modelPath)),
    };
  }

  async classify(context: RoutingClassificationContext, options: RoutingClassificationOptions = {}): Promise<LocalRoutingClassification> {
    options.signal?.throwIfAborted();
    const startedAt = Date.now();
    let fallbackReason: string | undefined;
    if (this.options.classifier) {
      try {
        const result = await withCancellation(this.options.classifier.classify(context, options), options.signal);
        options.signal?.throwIfAborted();
        return result;
      } catch (error) {
        options.signal?.throwIfAborted();
        fallbackReason = error instanceof Error ? error.message : String(error);
      }
    } else if (this.options.complete) {
      try {
        const raw = await withCancellation(this.options.complete(this.buildPrompt(context), options), options.signal);
        options.signal?.throwIfAborted();
        const parsed = JSON.parse(raw) as Partial<LocalRoutingClassification>;
        if (this.isTaskType(parsed.taskType) && this.isComplexity(parsed.complexity)) {
          return {
            taskType: parsed.taskType,
            complexity: parsed.complexity,
            confidence: typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? clamp(parsed.confidence, 0, 1) : 0.5,
            rationale: typeof parsed.rationale === 'string' ? parsed.rationale : 'local model classification',
            backend: 'local-model',
          };
        }
        fallbackReason = 'Local model returned invalid taskType or complexity';
      } catch (error) {
        options.signal?.throwIfAborted();
        fallbackReason = error instanceof Error ? error.message : String(error);
        // Local models are an enhancement. Invalid output falls back to the
        // deterministic classifier so routing never blocks task execution.
      }
    }
    options.signal?.throwIfAborted();
    const status = fallbackReason ? this.options.classifier?.getStatus() : undefined;
    return { ...this.classifyHeuristically(context), ...(fallbackReason ? { fallbackReason, durationMs: Date.now() - startedAt, model: status?.model, promptVersion: status?.promptVersion, backendVersion: status?.backendVersion, modelDigest: status?.modelDigest } : {}) };
  }

  private classifyHeuristically(context: Pick<TaskContext, 'description' | 'type' | 'complexity'>): LocalRoutingClassification {
    const text = context.description.toLocaleLowerCase();
    const explicitType = context.type !== 'general' ? context.type : undefined;
    const scored = TASK_KEYWORDS.map(({ type, words }) => ({ type, score: words.reduce((sum, word) => sum + (text.includes(word.toLocaleLowerCase()) ? 1 : 0), 0) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    const taskType = explicitType ?? (top?.score ? top.type : 'general');
    const explicitComplexity = context.complexity;
    const complexity = explicitComplexity ?? this.inferComplexity(text);
    const matched = top?.score ? `${top.type} keyword match` : 'no specialized keyword match';
    return { taskType, complexity, confidence: top?.score ? Math.min(0.92, 0.58 + top.score * 0.08) : 0.55, rationale: `${matched}; ${complexity} complexity`, backend: 'heuristic' };
  }

  private inferComplexity(text: string): TaskComplexity {
    if (COMPLEXITY_KEYWORDS.high.some((word) => text.includes(word))) return 'high';
    if (COMPLEXITY_KEYWORDS.low.some((word) => text.includes(word))) return 'low';
    return 'medium';
  }

  private buildPrompt(context: Pick<TaskContext, 'description' | 'type' | 'complexity'>): string {
    return `Classify this task as JSON {"taskType":"code|reasoning|analysis|review|creative|general","complexity":"low|medium|high","confidence":0..1}.\nTask type hint: ${context.type}.\nComplexity hint: ${context.complexity ?? 'unknown'}.\nDescription:\n${context.description.slice(0, 8000)}`;
  }

  private isTaskType(value: unknown): value is TaskType {
    return value === 'code' || value === 'reasoning' || value === 'analysis' || value === 'review' || value === 'creative' || value === 'general';
  }

  private isComplexity(value: unknown): value is TaskComplexity { return value === 'low' || value === 'medium' || value === 'high'; }
}

function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }

// Kept dependency-free so the experiment can still load this exact source in memory.
function withCancellation<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason ?? new Error('任务已取消')); };
    signal.addEventListener('abort', aborted, { once: true });
    pending.then((value) => { signal.removeEventListener('abort', aborted); resolve(value); }, (error) => { signal.removeEventListener('abort', aborted); reject(error); });
    if (signal.aborted) aborted();
  });
}

