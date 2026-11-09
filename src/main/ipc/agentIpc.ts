import type { MainContext } from '../MainContext';
import { handle } from './register';

export function register(ctx: MainContext): void {
  const { agentRuntime } = ctx;
  handle('agent:describe', () => agentRuntime.describe());
  handle('agent:search-providers', () => agentRuntime.search.list());
  handle('agent:set-search-provider', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('无效的搜索后端');
    agentRuntime.search.setActive(id);
    return agentRuntime.search.list();
  });
}
