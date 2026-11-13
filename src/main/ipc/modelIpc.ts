import { publicModel } from '@core/agent/run/runHelpers';
import { restoreEndpoint } from '@core/models/EndpointSecrets';
import { bindModelUpdate, hasUsableCredentials, type ModelConfig, type ModelConfigInput } from '@core/models/ModelConfig';
import { fetchModelIdentifiers, testModelConnection, type ModelConnectionInput } from '@core/providers/ModelConnection';
import type { MainContext } from '../MainContext';
import { handle } from './register';

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
    if (input.baseURL) restoreEndpoint(input.baseURL);
    const now = new Date();
    const config: ModelConfig = { ...input, id: makeId(input), createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now } as ModelConfig;
    const saved = registry.registerModel(config);
    return publicModel(saved);
  });
  handle('model:update', (_event, id: string, updates: Partial<ModelConfig>) => {
    if (!updates || typeof updates !== 'object') throw new Error('模型更新参数无效');
    const existing = registry.getModel(id);
    if (!existing) throw new Error(`Model not found: ${id}`);
    if ('baseURL' in updates) {
      if (updates.baseURL === existing.baseURL && existing.endpointCredentialError) {
        updates = { ...updates };
        delete updates.baseURL;
      } else updates = { ...updates, baseURL: restoreEndpoint(updates.baseURL, existing.baseURL) };
    }
    const next = bindModelUpdate(existing, updates);
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
