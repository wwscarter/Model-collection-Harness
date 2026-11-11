import { supportsOperation } from '@core/models/ModelOperations';
import { hasUsableCredentials, type ModelConfig, type ModelCapabilityType } from '@core/models/ModelConfig';
import { modelRegistry } from '@core/models/ModelRegistry';
import { LocalRoutingModel, type LocalRoutingClassification } from './LocalRoutingModel';
export interface RoutingRegistry { getEnabledModels(): ModelConfig[]; }
export interface RoutingPerformance { getRoutingAdjustment(modelId: string, taskType?: string): number; }

export type TaskType = 'code' | 'reasoning' | 'analysis' | 'review' | 'creative' | 'general';
export type TaskComplexity = 'low' | 'medium' | 'high';
export type RoutingStrategy = 'single' | 'plan' | 'parallel' | 'plan+verify' | 'escalate';

export interface TaskContext {
  id: string;
  type: TaskType;
  description: string;
  complexity?: TaskComplexity;
  estimatedTokens?: number;
  budget?: number;
  /** Minimal conversation context for resolving follow-up requests. */
  priorContext?: string;
}

export interface RoutingOptions { signal?: AbortSignal; skipSemantic?: boolean; }

export interface RoutingDecision {
  modelId: string;
  taskType: TaskType;
  complexity: TaskComplexity;
  reason: string;
  confidence: number;
  alternativeModels: string[];
  /** Models to try after the primary fails before producing output. */
  fallbackModels?: string[];
  strategy?: RoutingStrategy;
  ruleId?: string;
  collaboratorModelIds?: string[];
  estimatedCost: number;
  estimatedDuration: number;
  /** Classifier evidence is separate from the execution model's capability score. */
  classification?: LocalRoutingClassification;
}

const capabilityForTask: Record<TaskType, ModelCapabilityType> = {
  code: 'code', reasoning: 'reasoning', analysis: 'reasoning', review: 'code', creative: 'creative', general: 'reasoning'
};

export function estimateModelCost(model: ModelConfig, estimatedTokens = 2000): number {
  return (estimatedTokens * 0.7 * model.costPer1kTokens.input + estimatedTokens * 0.3 * model.costPer1kTokens.output) / 1000;
}

/** Honor an explicit primary model; otherwise prefer capability, priority, and cost. */
export class AgentRouter {
  constructor(
    private readonly registry: RoutingRegistry = modelRegistry,
    private readonly performance?: RoutingPerformance,
    private readonly localModel: LocalRoutingModel = new LocalRoutingModel(),
  ) {}

  getLocalModelStatus(): ReturnType<LocalRoutingModel['getStatus']> { return this.localModel.getStatus(); }

  async routeTask(context: TaskContext, candidates = this.registry.getEnabledModels(), options: RoutingOptions = {}): Promise<RoutingDecision> {
    options.signal?.throwIfAborted();
    const enabled = candidates.filter((model) => model.enabled && supportsOperation(model, 'text.chat') && hasUsableCredentials(model));
    if (!enabled.length) {
      if (candidates.some((model) => model.enabled) && !candidates.some((model) => model.enabled && supportsOperation(model, 'text.chat'))) throw new Error('没有支持文本对话的可用模型');
      const anyEnabled = candidates.some((model) => model.enabled);
      throw new Error(anyEnabled ? '已启用的模型都没有可用的 API Key，请先在模型设置中配置凭据' : 'No enabled models are configured');
    }
    // Pinned sessions need labels for reporting, without waiting for semantic inference.
    const classifier = options.skipSemantic ? new LocalRoutingModel() : this.localModel;
    const localClassification = await classifier.classify(context, { signal: options.signal });
    options.signal?.throwIfAborted();
    const taskType = context.type === 'general' ? localClassification.taskType : context.type;
    const complexity = context.complexity ?? localClassification.complexity;
    const capability = capabilityForTask[taskType] ?? 'reasoning';
    const ranked = [...enabled].sort((a, b) => {
      const primaryPreference = Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary));
      if (primaryPreference) return primaryPreference;
      const score = (m: ModelConfig) => m.capabilities.find(c => c.type === capability)?.score ?? 0;
      const complexityBonus = (m: ModelConfig) => {
        const base = complexity === 'high'
          ? score(m) * 0.8 + (m.intelligenceScore ?? score(m)) * 0.2
          : score(m) * 0.8 + (100 - m.costPer1kTokens.input) * 0.2;
        return base * (this.performance?.getRoutingAdjustment(m.id, taskType) ?? 1);
      };
      return complexityBonus(b) - complexityBonus(a) || a.priority - b.priority || a.costPer1kTokens.input - b.costPer1kTokens.input;
    });
    const selected = ranked[0];
    const estimatedTokens = context.estimatedTokens ?? 2000;
    const estimatedCost = estimateModelCost(selected, estimatedTokens);
    const budgetNote = context.budget !== undefined && estimatedCost > context.budget ? ' Estimated cost exceeds the task budget.' : '';
    return {
      modelId: selected.id,
      taskType,
      complexity,
      reason: selected.isPrimary
        ? `Explicit primary model for ${taskType} at ${complexity} complexity (${localClassification.backend}).${budgetNote}`
        : `Capability match for ${taskType} at ${complexity} complexity (${localClassification.backend}).${budgetNote}`,
      confidence: Math.min(0.98, 0.62 + (selected.capabilities.find(c => c.type === capability)?.score ?? 0) / 300),
      classification: localClassification,
      alternativeModels: ranked.slice(1, 3).map(model => model.id),
      estimatedCost,
      estimatedDuration: Math.max(1000, estimatedTokens * (complexity === 'high' ? 12 : 7))
    };
  }
}

export const agentRouter = new AgentRouter();
