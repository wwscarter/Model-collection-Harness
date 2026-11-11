import { PRESET_MODELS, type ModelConfig } from './ModelConfig';
import { cloneModelOperations, type ModelOperations } from './ModelOperations';

/** Identity and configured estimates as they stood when this call was made. */
export interface ModelSnapshot {
  configurationId: string;
  modelId: string;
  name: string;
  provider: string;
  endpointOrigin?: string;
  costPer1kTokens: { input: number; output: number };
  pricingBasis: 'configured-token-rates';
  legacyPresetRates?: boolean;
  configurationUpdatedAt: string;
  operations?: ModelOperations;
}

const DEFAULT_ORIGINS: Partial<Record<ModelConfig['provider'], string>> = {
  openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com', deepseek: 'https://api.deepseek.com',
};

/** A factual warning only: an edited preset still carries exactly its original rates. */
export function hasLegacyPresetRates(model: Pick<ModelConfig, 'id' | 'modelId' | 'costPer1kTokens'> & { provider: string }): boolean {
  const preset = PRESET_MODELS.find((candidate) => {
    const id = candidate.provider + '-' + candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return id === model.id;
  });
  return Boolean(preset && (model.provider !== preset.provider || model.modelId !== preset.modelId)
    && model.costPer1kTokens.input === preset.costPer1kTokens.input && model.costPer1kTokens.output === preset.costPer1kTokens.output);
}

/** Whitelist only: never spread configuration objects or preserve URL secrets. */
export function snapshotModel(model: ModelConfig): ModelSnapshot {
  let endpointOrigin: string | undefined;
  try {
    const url = new URL(model.baseURL?.trim() || DEFAULT_ORIGINS[model.provider] || '');
    if (url.protocol === 'http:' || url.protocol === 'https:') endpointOrigin = url.origin;
  } catch { /* An absent/invalid endpoint must not prevent recording the run. */ }
  const updatedAt = new Date(model.updatedAt);
  return {
    configurationId: model.id,
    modelId: model.modelId,
    name: model.name,
    provider: model.provider,
    ...(endpointOrigin ? { endpointOrigin } : {}),
    costPer1kTokens: { input: model.costPer1kTokens.input, output: model.costPer1kTokens.output },
    pricingBasis: 'configured-token-rates',
    ...(hasLegacyPresetRates(model) ? { legacyPresetRates: true } : {}),
    configurationUpdatedAt: Number.isFinite(updatedAt.getTime()) ? updatedAt.toISOString() : '',
    ...(model.operations === undefined ? {} : { operations: cloneModelOperations(model.operations) }),
  };
}
