import {
  cloneModelConfig,
  ModelCapabilityType,
  ModelCapability,
  ModelConfig,
  ModelConfigInput,
  PRESET_MODELS,
  validateModelConfig,
} from "./ModelConfig";
import { ModelStore } from "../storage/ModelStorage";

export interface ModelRegistryOptions {
  /** Add the three editable provider presets when they are absent. */
  initializePresets?: boolean;
  /** Write registry mutations through to the configured storage. */
  persist?: boolean;
}

function presetId(provider: string, name: string): string {
  return `${provider}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function toConfig(input: ModelConfigInput): ModelConfig {
  const now = new Date();
  // The renderer's first-run form intentionally sends a small payload. Fill in
  // safe defaults here so IPC callers do not need to duplicate model metadata.
  const raw = input as Partial<ModelConfig> & { capabilities?: unknown };
  if (typeof raw.provider !== "string" || typeof raw.name !== "string" || typeof raw.modelId !== "string" || !raw.provider || !raw.name || !raw.modelId) {
    throw new Error("Provider, model name, and model id are required");
  }
  const capabilities: ModelCapability[] = Array.isArray(raw.capabilities)
    ? raw.capabilities.map((capability) => {
        if (typeof capability === "string") {
          const type = capability === "code" || capability === "creative" || capability === "vision" || capability === "longcontext"
            ? capability
            : "reasoning";
          return { type, score: 50 };
        }
        if (!capability || typeof capability !== "object") throw new Error("Invalid model capability");
        const value = capability as { type?: string; score?: number };
        const type = value.type === "code" || value.type === "creative" || value.type === "vision" || value.type === "longcontext"
          ? value.type
          : "reasoning";
        return { type, score: value.score ?? 50 };
      })
    : [];
  const config: ModelConfig = {
    id: raw.id || presetId(raw.provider, raw.name),
    provider: raw.provider,
    name: raw.name,
    apiKey: raw.apiKey || "",
    baseURL: raw.baseURL,
    modelId: raw.modelId,
    providerCategory: raw.providerCategory ?? (raw.provider === "custom" ? "compatible_gateway" : "official"),
    availableModels: raw.availableModels ?? [raw.modelId],
    temperature: raw.temperature ?? 0.6,
    enableThinking: raw.enableThinking ?? true,
    isPrimary: raw.isPrimary ?? false,
    contextWindow: raw.contextWindow ?? raw.maxTokens ?? 4096,
    intelligenceScore:
      raw.intelligenceScore ?? capabilities.find((capability) => capability.type === "reasoning")?.score ?? 70,
    costPer1kTokens: { input: raw.costPer1kTokens?.input ?? 0, output: raw.costPer1kTokens?.output ?? 0 },
    capabilities,
    maxTokens: raw.maxTokens ?? 4096,
    rateLimit: { requestsPerMinute: raw.rateLimit?.requestsPerMinute ?? 60, tokensPerDay: raw.rateLimit?.tokensPerDay ?? 1_000_000 },
    enabled: raw.enabled ?? false,
    priority: raw.priority ?? 0,
    credentialError: raw.credentialError,
    createdAt: raw.createdAt ? new Date(raw.createdAt) : now,
    updatedAt: raw.updatedAt ? new Date(raw.updatedAt) : now,
  };
  validateModelConfig(config);
  return config;
}

/** In-memory model registry with optional SQLite-backed persistence. */
export class ModelRegistry {
  private static instance: ModelRegistry | undefined;
  private readonly models = new Map<string, ModelConfig>();
  private readonly storage?: ModelStore;
  private readonly persist: boolean;

  constructor(storage?: ModelStore, options: ModelRegistryOptions = {}) {
    this.storage = storage;
    this.persist = options.persist ?? Boolean(storage);

    if (storage) this.loadFromStorage();
    if (options.initializePresets ?? false) this.initializePresets();
  }

  static getInstance(storage?: ModelStore, options: ModelRegistryOptions = {}): ModelRegistry {
    if (!ModelRegistry.instance) {
      ModelRegistry.instance = new ModelRegistry(storage, {
        initializePresets: options.initializePresets ?? true,
        persist: options.persist,
      });
    }
    return ModelRegistry.instance;
  }

  /** Replace the singleton in tests or when the app changes its database. */
  static resetInstance(): void {
    ModelRegistry.instance = undefined;
  }

  private initializePresets(): void {
    for (const preset of PRESET_MODELS) {
      const id = presetId(preset.provider, preset.name);
      if (this.models.has(id)) continue;
      this.registerModel(toConfig({ ...preset, id, apiKey: "" }), { persist: this.persist });
    }
  }

  loadFromStorage(): void {
    if (!this.storage) return;
    this.models.clear();
    for (const model of this.storage.getAllModels()) {
      this.models.set(model.id, cloneModelConfig(model));
    }
  }

  registerModel(input: ModelConfig | ModelConfigInput, options: { persist?: boolean } = {}): ModelConfig {
    const config = toConfig(input as ModelConfigInput);
    this.commitModel(config, options.persist ?? this.persist);
    return cloneModelConfig(config);
  }

  getModel(id: string): ModelConfig | undefined {
    const model = this.models.get(id);
    return model ? cloneModelConfig(model) : undefined;
  }

  getAllModels(): ModelConfig[] {
    return Array.from(this.models.values()).map(cloneModelConfig);
  }

  getEnabledModels(): ModelConfig[] {
    return this.getAllModels().filter((model) => model.enabled);
  }

  updateModel(id: string, updates: Partial<ModelConfig>): ModelConfig | undefined {
    const existing = this.models.get(id);
    if (!existing) return undefined;
    const updated = toConfig({
      ...existing,
      ...updates,
      // A new (or explicitly cleared) key resolves the credential error; other
      // edits keep the warning until the user fixes the credential.
      credentialError: updates.apiKey === undefined ? existing.credentialError : undefined,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
    });
    this.commitModel(updated, this.persist);
    return cloneModelConfig(updated);
  }

  private commitModel(config: ModelConfig, persist: boolean): void {
    const changed: ModelConfig[] = config.isPrimary
      ? [...this.models.values()].filter((model) => model.id !== config.id && model.isPrimary).map((model) => ({ ...model, isPrimary: false, updatedAt: new Date() }))
      : [];
    changed.push(config);
    // The registry must remain unchanged when persistence rejects a mutation.
    if (persist && this.storage) {
      if (this.storage.saveModels) this.storage.saveModels(changed.map(cloneModelConfig));
      else for (const model of changed) this.storage.saveModel(cloneModelConfig(model));
    }
    for (const model of changed) this.models.set(model.id, cloneModelConfig(model));
  }

  setPrimaryModel(id: string): ModelConfig[] {
    if (!this.models.has(id)) throw new Error(`Model not found: ${id}`);
    this.updateModel(id, { isPrimary: true, enabled: true });
    return this.getAllModels();
  }

  deleteModel(id: string): boolean {
    if (!this.models.has(id)) return false;
    if (this.persist) this.storage?.deleteModel(id);
    return this.models.delete(id);
  }

  async getModelForCapability(capability: ModelCapabilityType): Promise<ModelConfig | undefined> {
    return this.getEnabledModels()
      .filter((model) => model.capabilities.some((entry) => entry.type === capability))
      .sort((a, b) => {
        const scoreA = a.capabilities.find((entry) => entry.type === capability)?.score ?? 0;
        const scoreB = b.capabilities.find((entry) => entry.type === capability)?.score ?? 0;
        return scoreB - scoreA || a.priority - b.priority;
      })[0];
  }

  getCostOptimalModel(): ModelConfig | undefined {
    return this.getEnabledModels().sort(
      (a, b) =>
        a.costPer1kTokens.input + a.costPer1kTokens.output -
          (b.costPer1kTokens.input + b.costPer1kTokens.output) || a.priority - b.priority,
    )[0];
  }

  clear(): void {
    for (const id of this.models.keys()) {
      if (this.persist) this.storage?.deleteModel(id);
    }
    this.models.clear();
  }
}

/** Convenience singleton for small integrations. Prefer an injected registry in tests. */
export const modelRegistry = ModelRegistry.getInstance(undefined, { initializePresets: true, persist: false });

