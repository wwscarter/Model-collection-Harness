import { validateHookConfig } from '@core/hooks/HookConfig';
import type { HookStore } from '@core/hooks/HookStore';
import type { MainContext } from '../MainContext';
import { handle } from './register';

export type HooksIpcContext = Pick<MainContext, 'projects' | 'trustStore'> & { hookStore: HookStore };

export function register(ctx: HooksIpcContext): void {
  handle('agent:hooks:list', async (_event, ...args: unknown[]) => {
    if (args.length) throw new Error('Hooks 列表不接受参数，请使用当前项目');
    const root = ctx.projects.getRoot();
    const listing = await ctx.hookStore.list(root);
    if (ctx.projects.getRoot() !== root) throw new Error('当前项目已变化，请刷新 Hooks 列表');
    return { ...listing, diagnostics: [...new Set([...ctx.trustStore.diagnostics, ...listing.diagnostics])] };
  });

  handle('agent:hooks:save', (_event, input: unknown) => ctx.hookStore.saveGlobal(validateHookConfig(input)));

  handle('agent:hooks:trust', async (_event, sha256: unknown) => {
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('项目 Hooks 内容指纹无效');
    const root = ctx.projects.getRoot();
    if (!root) throw new Error('请先选择项目并查看 Hooks 完整配置');
    const file = (await ctx.hookStore.list(root)).project;
    if (ctx.projects.getRoot() !== root) throw new Error('当前项目已变化，请重新查看 Hooks 后确认');
    if (!file?.config || file.error) throw new Error(file?.error || '项目 Hooks 不存在或不可读取');
    if (file.hash !== sha256) throw new Error('Hooks 已变化，请重新查看完整配置后确认');
    // The project file is fixed by the host and was just read for its current hash.
    ctx.trustStore.grant({ projectRoot: root, file: '.newai/hooks.json', sha256: file.hash });
    return { success: true };
  });
}
