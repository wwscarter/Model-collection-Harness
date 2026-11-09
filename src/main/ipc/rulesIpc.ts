import path from 'node:path';
import { MAX_RULE_BYTES, ruleId } from '@core/agent/RuleFiles';
import { formatRules } from '@core/agent/RulePrompt';
import type { MainContext } from '../MainContext';
import { handle } from './register';

const LIMIT_NOTICE = '规则注入片段总上限为 8000 字符（包含来源标记）；超出的内容已截断或省略，预览仍显示完整规则。';

export function register(ctx: MainContext): void {
  handle('agent:rules:list', async (_event, ...args: unknown[]) => {
    if (args.length) throw new Error('规则列表不接受参数，请使用当前项目');
    const projectRoot = ctx.projects.getRoot();
    const [catalog, loaded] = await Promise.all([ctx.rulesLoader.list({ projectRoot }), ctx.rulesLoader.load({ projectRoot })]);
    if (ctx.projects.getRoot() !== projectRoot) throw new Error('当前项目已变化，请刷新规则列表');
    const formatted = formatRules(loaded);
    const truncated = catalog.truncated || formatted.truncated;
    return {
      global: catalog.global, project: catalog.project, truncated,
      diagnostics: [...new Set([...catalog.diagnostics, ...formatted.diagnostics, ...(truncated ? [LIMIT_NOTICE] : [])])],
    };
  });

  handle('agent:rules:save', (_event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('规则参数无效');
    const value = input as { name?: unknown; content?: unknown; enabled?: unknown };
    const name = ruleId(value.name);
    if (typeof value.content !== 'string' || Buffer.byteLength(value.content, 'utf8') > MAX_RULE_BYTES) throw new Error('单条规则内容必须为不超过 256KB 的文本');
    if (typeof value.enabled !== 'boolean') throw new Error('规则启用状态无效');
    return ctx.rulesLoader.saveGlobal({ name, content: value.content, enabled: value.enabled });
  });

  handle('agent:rules:set-enabled', (_event, name: unknown, enabled: unknown) => {
    const id = ruleId(name);
    if (typeof enabled !== 'boolean') throw new Error('规则启用状态无效');
    return ctx.rulesLoader.setEnabled(id, enabled);
  });

  handle('agent:rules:remove', async (_event, name: unknown) => ({ success: await ctx.rulesLoader.removeGlobal(ruleId(name)) }));

  handle('agent:rules:trust', async (_event, file: unknown, sha256: unknown) => {
    if (typeof file !== 'string' || !file || file.length > 4_096 || file.includes('\0') || !path.isAbsolute(file)) throw new Error('项目规则文件参数无效');
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('项目规则内容指纹无效');
    const projectRoot = ctx.projects.getRoot();
    if (!projectRoot) throw new Error('请先选择项目并查看规则全文');
    const catalog = await ctx.rulesLoader.list({ projectRoot });
    if (ctx.projects.getRoot() !== projectRoot) throw new Error('当前项目已变化，请重新查看规则后确认');
    const entry = catalog.project.find((rule) => rule.path === path.resolve(file));
    if (!entry) throw new Error('当前项目规则不存在或不可读取，请刷新后重试');
    if (entry.blocked) throw new Error(entry.blocked);
    if (entry.hash !== sha256) throw new Error('规则内容已变化，请重新查看全文后确认');
    // Grant only the freshly catalogued file. No renderer-supplied path reaches
    // the store, and no awaited work can change project selection before grant.
    ctx.trustStore.grant({ projectRoot, file: entry.path, sha256: entry.hash });
    return { ...entry, trusted: true };
  });
}
