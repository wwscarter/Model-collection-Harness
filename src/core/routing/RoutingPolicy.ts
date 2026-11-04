import fs from 'node:fs';
import { hasUsableCredentials, type ModelConfig } from '@core/models/ModelConfig';
import type { AgentRouter, RoutingDecision, RoutingStrategy, TaskComplexity, TaskContext, TaskType } from './AgentRouter';

export interface RoutingRule {
  id: string;
  enabled: boolean;
  priority: number;
  when: {
    taskTypes?: TaskType[];
    complexity?: TaskComplexity[];
    promptKeywords?: string[];
  };
  then: {
    primaryModelId?: string;
    strategy?: RoutingStrategy;
    collaboratorModelIds?: string[];
    fallbackModelIds?: string[];
  };
}

export interface RoutingPolicy {
  version: 1;
  rules: RoutingRule[];
  defaults: { strategy: RoutingStrategy };
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = { version: 1, rules: [], defaults: { strategy: 'single' } };

export interface RoutingGuard { isAvailable(modelId: string): boolean; }

const STRATEGIES: RoutingStrategy[] = ['single', 'plan', 'parallel', 'plan+verify'];
const TASK_TYPES: TaskType[] = ['code', 'reasoning', 'analysis', 'review', 'creative', 'general'];
const COMPLEXITIES: TaskComplexity[] = ['low', 'medium', 'high'];

function strings(value: unknown, limit = 30): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, limit);
}

/** Validate on-disk rules defensively; one bad rule must not prevent startup. */
export function loadRoutingPolicy(filePath: string): { policy: RoutingPolicy; diagnostics: string[] } {
  const diagnostics: string[] = [];
  let parsed: unknown;
  try {
    if (!fs.existsSync(filePath)) return { policy: DEFAULT_ROUTING_POLICY, diagnostics };
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    diagnostics.push(`无法读取路由规则：${error instanceof Error ? error.message : String(error)}`);
    return { policy: DEFAULT_ROUTING_POLICY, diagnostics };
  }
  if (!parsed || typeof parsed !== 'object') return { policy: DEFAULT_ROUTING_POLICY, diagnostics };
  const raw = parsed as { version?: unknown; rules?: unknown; defaults?: unknown };
  const rules: RoutingRule[] = [];
  for (const [index, value] of (Array.isArray(raw.rules) ? raw.rules : []).entries()) {
    if (!value || typeof value !== 'object') { diagnostics.push(`规则 #${index + 1} 不是对象，已忽略`); continue; }
    const item = value as Record<string, unknown>;
    const when = (item.when && typeof item.when === 'object' ? item.when : {}) as Record<string, unknown>;
    const then = (item.then && typeof item.then === 'object' ? item.then : {}) as Record<string, unknown>;
    const primaryModelId = typeof then.primaryModelId === 'string' ? then.primaryModelId.trim() : undefined;
    const strategy = typeof then.strategy === 'string' && STRATEGIES.includes(then.strategy as RoutingStrategy) ? then.strategy as RoutingStrategy : undefined;
    const taskTypes = strings(when.taskTypes)?.filter((type): type is TaskType => TASK_TYPES.includes(type as TaskType));
    const complexity = strings(when.complexity)?.filter((value): value is TaskComplexity => COMPLEXITIES.includes(value as TaskComplexity));
    if (!primaryModelId && !strategy) { diagnostics.push(`规则 #${index + 1} 没有 primaryModelId 或 strategy，已忽略`); continue; }
    rules.push({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `rule-${index + 1}`,
      enabled: item.enabled !== false,
      priority: Number.isFinite(item.priority as number) ? Number(item.priority) : 0,
      when: { taskTypes, complexity, promptKeywords: strings(when.promptKeywords, 10) },
      then: {
        primaryModelId, strategy: strategy ?? 'single',
        collaboratorModelIds: strings(then.collaboratorModelIds, 4),
        fallbackModelIds: strings(then.fallbackModelIds, 3),
      },
    });
  }
  const defaultStrategy = raw.defaults && typeof raw.defaults === 'object' && STRATEGIES.includes((raw.defaults as { strategy?: RoutingStrategy }).strategy as RoutingStrategy)
    ? (raw.defaults as { strategy: RoutingStrategy }).strategy : 'single';
  return { policy: { version: 1, rules, defaults: { strategy: defaultStrategy } }, diagnostics };
}

function matches(rule: RoutingRule, decision: RoutingDecision, description: string): boolean {
  if (rule.when.taskTypes?.length && !rule.when.taskTypes.includes(decision.taskType)) return false;
  if (rule.when.complexity?.length && !rule.when.complexity.includes(decision.complexity)) return false;
  if (rule.when.promptKeywords?.length && !rule.when.promptKeywords.some((keyword) => description.toLowerCase().includes(keyword.toLowerCase()))) return false;
  return true;
}

/**
 * Applies user rules and hard availability guards on top of the existing
 * capability router. It never chooses a disabled, keyless or quota-exhausted
 * model; fallbackModels is the ordered retry chain for the execution phase.
 */
export class RoutingPolicyEngine {
  constructor(private readonly router: AgentRouter, private readonly policy: RoutingPolicy = DEFAULT_ROUTING_POLICY) {}

  async routeTask(context: TaskContext, models: ModelConfig[], guard?: RoutingGuard): Promise<RoutingDecision> {
    const base = await this.router.routeTask(context);
    const usable = models.filter((model) => model.enabled && hasUsableCredentials(model) && (guard?.isAvailable(model.id) ?? true));
    if (!usable.length) throw new Error('没有满足凭据、配额与上下文约束的可用模型');
    const available = new Set(usable.map((model) => model.id));
    const rule = [...this.policy.rules]
      .filter((candidate) => candidate.enabled && matches(candidate, base, context.description))
      .sort((a, b) => b.priority - a.priority)[0];
    // A rule that names an unavailable primary must not apply its strategy or
    // fallback list; otherwise a quota-exhausted model would still steer routing.
    const appliedRule = rule && (!rule.then.primaryModelId || available.has(rule.then.primaryModelId)) ? rule : undefined;

    let primary = appliedRule?.then.primaryModelId ?? base.modelId;
    if (!available.has(primary)) primary = base.alternativeModels.find((id) => available.has(id)) ?? usable[0].id;
    const ruleFallback = appliedRule?.then.fallbackModelIds ?? [];
    const fallbackModels = [...new Set([...ruleFallback, ...base.alternativeModels])].filter((id) => id !== primary && available.has(id)).slice(0, 3);
    const strategy = appliedRule?.then.strategy ?? this.policy.defaults.strategy;
    return {
      ...base,
      modelId: primary,
      alternativeModels: fallbackModels,
      fallbackModels,
      strategy,
      ruleId: appliedRule?.id,
      reason: appliedRule
        ? `规则「${appliedRule.id}」为 ${base.taskType}/${base.complexity} 选择 ${primary}。 ${base.reason}`
        : base.reason,
    };
  }
}
