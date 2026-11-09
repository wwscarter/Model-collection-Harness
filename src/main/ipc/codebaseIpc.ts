import { EmbeddingClient } from '@core/codebase/EmbeddingClient';
import { saveCodeSearchConfig, validateCodeSearchConfig } from '@core/codebase/CodeSearchConfig';
import type { MainContext } from '../MainContext';
import { handle } from './register';

export function register(ctx: MainContext): void {
  const configuration = () => ({ config: ctx.codeSearch.config, baseURL: ctx.routingService.getConfiguration().settings.classifier.baseURL, status: ctx.semanticSearch.getStatus() });
  handle('codebase:get', configuration);
  handle('codebase:set', (_event, input: unknown) => {
    ctx.codeSearch.config = saveCodeSearchConfig(ctx.codeSearchConfigPath, input);
    return configuration();
  });
  handle('codebase:probe', async (_event, input: unknown) => {
    const config = validateCodeSearchConfig(input);
    return new EmbeddingClient(configuration().baseURL, config.model, config.timeoutMs).probe();
  });
  handle('codebase:reindex', async () => {
    const root = ctx.projects.getRoot();
    if (!root) throw new Error('请先选择项目');
    return ctx.codebase.refresh(root);
  });
}
