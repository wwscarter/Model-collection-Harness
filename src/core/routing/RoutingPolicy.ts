import fs from 'node:fs';
import { hasUsableCredentials, type ModelConfig } from '@core/models/ModelConfig';
import type { AgentRouter, RoutingDecision, RoutingStrategy, TaskComplexity, TaskContext, TaskType } from './AgentRouter';
import { estimateModelCost } from './AgentRouter';

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

const STRATEGIES: RoutingStrategy[] = ['single', 'plan', 'parallel', 'plan+verify', 'escalate'];
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
  return parseRoutingPolicy(parsed);
}

export function parseRoutingPolicy(parsed: unknown): { policy: RoutingPolicy; diagnostics: string[] } {
  const diagnostics: string[] = [];
  if (!parsed || typeof parsed !== 'object') return { policy: DEFAULT_ROUTING_POLICY, diagnostics };
  const raw = parsed as { version?: unknown; rules?: unknown; defaults?: unknown };
  if (raw.version !== undefined && raw.version !== 1) {
    diagnostics.push('不支持的路由规则版本，已使用默认规则');
    return { policy: DEFAULT_ROUTING_POLICY, diagnostics };
  }
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
    if ((Array.isArray(when.taskTypes) && when.taskTypes.length > 0 && !taskTypes?.length)
      || (Array.isArray(when.complexity) && when.complexity.length > 0 && !complexity?.length)) {
      diagnostics.push(`规则 #${index + 1} 的任务类型或复杂度无效，已忽略`);
      continue;
    }
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

/** Save-time validation must reject settings that startup recovery would discard. */
export function validateRoutingPolicy(value: unknown): RoutingPolicy {
  const object = (input: unknown, label: string): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label}必须是对象`);
    return input as Record<string, unknown>;
  };
  const keys = (input: Record<string, unknown>, allowed: string[], label: string) => {
    const unknown = Object.keys(input).find((key) => !allowed.includes(key));
    if (unknown) throw new Error(`${label}包含未知字段「${unknown}」`);
  };
  const list = (input: unknown, label: string, maximum: number, allowed?: string[]) => {
    if (input === undefined) return;
    if (!Array.isArray(input) || input.length > maximum || input.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${label}须为最多 ${maximum} 个非空字符串组成的数组`);
    if (allowed && input.some((item) => !allowed.includes(item.trim()))) throw new Error(`${label}包含不支持的值`);
    if (new Set(input.map((item: string) => item.trim())).size !== input.length) throw new Error(`${label}不能重复`);
  };
  const raw = object(value, '路由规则');
  keys(raw, ['version', 'rules', 'defaults'], '路由规则');
  if (raw.version !== undefined && raw.version !== 1) throw new Error('不支持的路由规则版本');
  if (!Array.isArray(raw.rules)) throw new Error('rules 必须是规则数组');
  if (raw.defaults !== undefined) {
    const defaults = object(raw.defaults, '默认设置');
    keys(defaults, ['strategy'], '默认设置');
    if (!STRATEGIES.includes(defaults.strategy as RoutingStrategy)) throw new Error('默认策略无效');
  }
  const ids = new Set<string>();
  for (const [index, value] of raw.rules.entries()) {
    const label = `规则 #${index + 1}`;
    const rule = object(value, label);
    keys(rule, ['id', 'enabled', 'priority', 'when', 'then'], label);
    if (typeof rule.id !== 'string' || !rule.id.trim()) throw new Error(`${label}需要非空 ID`);
    if (ids.has(rule.id.trim())) throw new Error('规则 ID 不能重复');
    ids.add(rule.id.trim());
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') throw new Error(`${label} enabled 必须是布尔值`);
    if (rule.priority !== undefined && (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority))) throw new Error(`${label}优先级必须是有限数字`);
    const when = rule.when === undefined ? {} : object(rule.when, `${label} when`);
    keys(when, ['taskTypes', 'complexity', 'promptKeywords'], `${label} when`);
    list(when.taskTypes, `${label}任务类型`, 30, TASK_TYPES);
    list(when.complexity, `${label}复杂度`, 30, COMPLEXITIES);
    list(when.promptKeywords, `${label}关键词`, 10);
    const then = object(rule.then, `${label} then`);
    keys(then, ['primaryModelId', 'strategy', 'collaboratorModelIds', 'fallbackModelIds'], `${label} then`);
    if (then.primaryModelId !== undefined && (typeof then.primaryModelId !== 'string' || !then.primaryModelId.trim())) throw new Error(`${label}主模型 ID 无效`);
    if (then.strategy !== undefined && !STRATEGIES.includes(then.strategy as RoutingStrategy)) throw new Error(`${label}策略无效`);
    if (!then.primaryModelId && !then.strategy) throw new Error(`${label}需要主模型或策略`);
    list(then.collaboratorModelIds, `${label}协作模型`, 4);
    list(then.fallbackModelIds, `${label} fallback 模型`, 3);
  }
  return parseRoutingPolicy(raw).policy;
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

  async routeTask(context: TaskContext, models: ModelConfig[], guard?: RoutingGuard, options: import('./AgentRouter').RoutingOptions = {}): Promise<RoutingDecision> {
    options.signal?.throwIfAborted();
    const usable = models.filter((model) => model.enabled && hasUsableCredentials(model) && (guard?.isAvailable(model.id) ?? true));
    if (!usable.length) throw new Error('没有满足凭据、配额与上下文约束的可用模型');
    const base = await this.router.routeTask(context, usable, options);
    const available = new Set(usable.map((model) => model.id));
    const appliedRule = [...this.policy.rules]
      .filter((candidate) => candidate.enabled && matches(candidate, base, context.description)
        && (!candidate.then.primaryModelId || available.has(candidate.then.primaryModelId)))
      .sort((a, b) => b.priority - a.priority)[0];

    let primary = appliedRule?.then.primaryModelId ?? base.modelId;
    if (!available.has(primary)) primary = base.alternativeModels.find((id) => available.has(id)) ?? usable[0].id;
    const ruleFallback = appliedRule?.then.fallbackModelIds ?? [];
    const fallbackModels = [...new Set([...ruleFallback, base.modelId, ...base.alternativeModels])].filter((id) => id !== primary && available.has(id)).slice(0, 3);
    const collaboratorModelIds = (appliedRule?.then.collaboratorModelIds ?? []).filter((id) => id !== primary && available.has(id)).slice(0, 4);
    // High-complexity code gets an independent verifier by default; rules can
    // override this or opt out with strategy: 'single'.
    const defaultStrategy = base.taskType === 'code' && base.complexity === 'high' ? 'plan+verify' : this.policy.defaults.strategy;
    const strategy = appliedRule?.then.strategy ?? defaultStrategy;
    return {
      ...base,
      modelId: primary,
      estimatedCost: estimateModelCost(usable.find((model) => model.id === primary)!, context.estimatedTokens),
      alternativeModels: fallbackModels,
      fallbackModels,
      strategy,
      ruleId: appliedRule?.id,
      collaboratorModelIds,
      reason: appliedRule
        ? `规则「${appliedRule.id}」为 ${base.taskType}/${base.complexity} 选择 ${primary}。 ${base.reason}`
        : base.reason,
    };
  }
}
