import { credentialOrigin, hasUsableCredentials, type ModelConfig, type ModelConfigInput } from '@core/models/ModelConfig';
import { fetchModelIdentifiers, testModelConnection, type ModelConnectionInput } from '@core/providers/ModelConnection';
import type { MainContext } from '../MainContext';
import { handle } from './register';

function publicModel(model: ModelConfig) {
  const { apiKey, ...safe } = model;
  return { ...safe, hasApiKey: Boolean(apiKey) };
}

function makeId(input: ModelConfigInput): string {
  return input.id?.trim() || `${input.provider}-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now()}`;
}

export function register(ctx: MainContext): void {
  const { registry } = ctx;
  handle('model:list', () => registry.getAllModels().map(publicModel));
  handle('model:list-enabled', () => registry.getEnabledModels().map(publicModel));
  handle('model:register', (_event, input: ModelConfigInput) => {
    if (!input || typeof input !== 'object') throw new Error('模型配置无效');
    if (input.isPrimary && !hasUsableCredentials({ provider: input.provider, apiKey: input.apiKey ?? '', baseURL: input.baseURL })) throw new Error('该模型尚未配置可用的 API Key，不能设为主力路由');
    const now = new Date();
    const config: ModelConfig = { ...input, id: makeId(input), createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now } as ModelConfig;
    const saved = registry.registerModel(config);
    return publicModel(saved);
  });
  handle('model:update', (_event, id: string, updates: Partial<ModelConfig>) => {
    if (!updates || typeof updates !== 'object') throw new Error('模型更新参数无效');
    const existing = registry.getModel(id);
    if (!existing) throw new Error(`Model not found: ${id}`);
    let next = updates;
    // Changing the endpoint origin invalidates the stored key. Settings leaves
    // apiKey empty when the field is untouched, which used to keep sending the
    // old secret to the new host.
    const nextProvider = updates.provider ?? existing.provider;
    if (updates.baseURL !== undefined && updates.apiKey === undefined && credentialOrigin(existing.provider, existing.baseURL) !== credentialOrigin(nextProvider, updates.baseURL)) {
      next = { ...updates, apiKey: '' };
    }
    if (next.isPrimary && !hasUsableCredentials({ ...existing, ...next })) throw new Error('该模型尚未配置可用的 API Key，不能设为主力路由');
    const updated = registry.updateModel(id, next);
    if (!updated) throw new Error(`Model not found: ${id}`);
    return publicModel(updated);
  });
  handle('model:delete', (_event, id: string) => ({ success: registry.deleteModel(id) }));
  handle('model:set-primary', (_event, id: string) => {
    const model = registry.getModel(id);
    if (!model) throw new Error(`Model not found: ${id}`);
    if (!hasUsableCredentials(model)) throw new Error('该模型尚未配置可用的 API Key，不能设为主力路由');
    return registry.setPrimaryModel(id).map(publicModel);
  });
  handle('model:fetch-models', (_event, input: ModelConnectionInput) => fetchModelIdentifiers(input, registry));
  handle('model:test-draft', (_event, input: ModelConnectionInput) => testModelConnection(input, registry, ctx.routingService.getConfiguration().settings));
  handle('model:test-connection', async (_event, id: string) => {
    const model = registry.getModel(id);
    if (!model) throw new Error(`Model not found: ${id}`);
    return { ...await testModelConnection({ id, provider: model.provider }, registry, ctx.routingService.getConfiguration().settings), model: publicModel(model) };
  });
}
