/** Providers currently supported by the built-in adapters. */
export type ModelProvider = "openai" | "anthropic" | "google" | "deepseek" | "custom";
export type ProviderCategory = "official" | "compatible_gateway" | "custom_proxy" | "local_ollama";

/** Task capabilities used by the router when choosing a model. */
export type ModelCapabilityType =
  | "code"
  | "reasoning"
  | "creative"
  | "vision"
  | "longcontext";

export interface ModelCapability {
  type: ModelCapabilityType;
  /** A normalized capability score in the inclusive range 0..100. */
  score: number;
}

export interface ModelCost {
  /** Price in the application's currency per 1,000 input tokens. */
  input: number;
  /** Price in the application's currency per 1,000 output tokens. */
  output: number;
}

export interface ModelRateLimit {
  requestsPerMinute: number;
  tokensPerDay: number;
}

export interface ModelConfig {
  id: string;
  provider: ModelProvider;
  name: string;
  /** Decrypted only in memory. ModelStorage never writes this value as plain text. */
  apiKey: string;
  baseURL?: string;
  modelId: string;
  providerCategory?: ProviderCategory;
  availableModels?: string[];
  temperature?: number;
  /** Only the DeepSeek adapter sends this preference to supporting endpoints. */
  enableThinking?: boolean;
  /** An explicit route preference; disabled primary models are ignored. */
  isPrimary?: boolean;
  /** Maximum input context accepted by the model, in tokens. */
  contextWindow?: number;
  /** Overall intelligence estimate used for model comparison, from 0 to 100. */
  intelligenceScore?: number;
  costPer1kTokens: ModelCost;
  capabilities: ModelCapability[];
  maxTokens: number;
  rateLimit: ModelRateLimit;
  enabled: boolean;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Input accepted by the registry when creating a configuration. */
export type ModelConfigInput = Omit<ModelConfig, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<ModelConfig, "id" | "createdAt" | "updatedAt">>;

/**
 * Provider presets intentionally contain no credentials. They are editable defaults,
 * rather than a promise that these historical model IDs are still available upstream.
 */
export const PRESET_MODELS: ReadonlyArray<
  Omit<ModelConfig, "id" | "apiKey" | "createdAt" | "updatedAt"> &
    Partial<Pick<ModelConfig, "baseURL">>
> = [
  {
    provider: "openai",
    name: "GPT-4 Turbo",
    modelId: "gpt-4-turbo-preview",
    contextWindow: 128_000,
    intelligenceScore: 95,
    costPer1kTokens: { input: 0.01, output: 0.03 },
    capabilities: [
      { type: "code", score: 98 },
      { type: "reasoning", score: 95 },
      { type: "longcontext", score: 90 },
    ],
    maxTokens: 4_096,
    rateLimit: { requestsPerMinute: 90, tokensPerDay: 2_000_000 },
    enabled: false,
    priority: 0,
  },
  {
    provider: "anthropic",
    name: "Claude 3 Sonnet",
    modelId: "claude-3-sonnet-20240229",
    contextWindow: 200_000,
    intelligenceScore: 93,
    costPer1kTokens: { input: 0.003, output: 0.015 },
    capabilities: [
      { type: "code", score: 92 },
      { type: "reasoning", score: 93 },
      { type: "creative", score: 94 },
    ],
    maxTokens: 4_096,
    rateLimit: { requestsPerMinute: 100, tokensPerDay: 3_000_000 },
    enabled: false,
    priority: 1,
  },
  {
    provider: "google",
    name: "Gemini Pro",
    modelId: "gemini-pro",
    contextWindow: 100_000,
    intelligenceScore: 88,
    costPer1kTokens: { input: 0.0005, output: 0.0015 },
    capabilities: [
      { type: "reasoning", score: 88 },
      { type: "creative", score: 87 },
    ],
    maxTokens: 4_096,
    rateLimit: { requestsPerMinute: 100, tokensPerDay: 2_000_000 },
    enabled: false,
    priority: 2,
  },
];

export function cloneModelConfig(config: ModelConfig): ModelConfig {
  return {
    ...config,
    availableModels: config.availableModels ? [...config.availableModels] : undefined,
    costPer1kTokens: { ...config.costPer1kTokens },
    capabilities: config.capabilities.map((capability) => ({ ...capability })),
    rateLimit: { ...config.rateLimit },
    createdAt: new Date(config.createdAt),
    updatedAt: new Date(config.updatedAt),
  };
}

export function validateModelConfig(config: ModelConfig): void {
  if (!config.id.trim()) throw new Error("Model id is required");
  if (!config.name.trim()) throw new Error("Model name is required");
  if (!config.modelId.trim()) throw new Error("Provider model id is required");
  if (config.providerCategory !== undefined && !["official", "compatible_gateway", "custom_proxy", "local_ollama"].includes(config.providerCategory)) {
    throw new Error("Unknown provider category");
  }
  if (config.temperature !== undefined && (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 1.5)) {
    throw new Error("temperature must be between 0 and 1.5");
  }
  if (config.provider === "anthropic" && config.temperature !== undefined && config.temperature > 1) {
    throw new Error("Anthropic temperature must be between 0 and 1");
  }
  if (config.availableModels !== undefined && (!Array.isArray(config.availableModels) || config.availableModels.some((model) => typeof model !== "string" || !model.trim()))) {
    throw new Error("availableModels must contain non-empty model identifiers");
  }
  if (config.enableThinking !== undefined && typeof config.enableThinking !== "boolean") throw new Error("enableThinking must be a boolean");
  if (config.isPrimary !== undefined && typeof config.isPrimary !== "boolean") throw new Error("isPrimary must be a boolean");
  if (!Number.isFinite(config.contextWindow ?? config.maxTokens) || (config.contextWindow ?? config.maxTokens) <= 0) {
    throw new Error("contextWindow must be a positive number");
  }
  if (
    config.intelligenceScore !== undefined &&
    (!Number.isFinite(config.intelligenceScore) || config.intelligenceScore < 0 || config.intelligenceScore > 100)
  ) {
    throw new Error("intelligenceScore must be between 0 and 100");
  }
  if (config.provider === "custom" && !config.baseURL?.trim()) {
    throw new Error("A custom provider API address is required");
  }
  if (!Number.isFinite(config.maxTokens) || config.maxTokens <= 0) {
    throw new Error("maxTokens must be a positive number");
  }
  if (config.contextWindow !== undefined && config.maxTokens > config.contextWindow) {
    throw new Error("maxTokens cannot exceed contextWindow");
  }
  if (
    !Number.isFinite(config.costPer1kTokens.input) ||
    !Number.isFinite(config.costPer1kTokens.output) ||
    config.costPer1kTokens.input < 0 ||
    config.costPer1kTokens.output < 0
  ) {
    throw new Error("Token costs must be non-negative numbers");
  }
  for (const capability of config.capabilities) {
    if (!Number.isFinite(capability.score) || capability.score < 0 || capability.score > 100) {
      throw new Error(`Capability score must be between 0 and 100: ${capability.type}`);
    }
  }
}
