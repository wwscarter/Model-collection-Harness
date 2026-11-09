import path from 'node:path';
import fs from 'node:fs';
import type { TrustStore } from '@core/security/TrustStore';
import { containsSensitiveContent } from '@core/security/sensitiveContent';
import { atomicRuleWrite, readRuleText, regularRulePath } from '@core/agent/RuleFiles';
import { validateHookConfig, type HookConfig, type LoadedHook } from './HookConfig';

export interface HookFile { source: 'global' | 'project'; path: string; content: string; hash: string; trusted: boolean; config?: HookConfig; error?: string }
export interface HooksListing { global?: HookFile; project?: HookFile; diagnostics: string[] }

/** The only project configuration admitted here is the selected root's .newai/hooks.json. */
export class HookStore {
  private readonly agentDir: string;
  constructor(agentDir: string, private readonly trustStore: TrustStore) {
    fs.mkdirSync(agentDir, { recursive: true });
    this.agentDir = fs.realpathSync(agentDir);
  }

  async list(projectRoot?: string, signal?: AbortSignal): Promise<HooksListing> {
    const listing: HooksListing = { diagnostics: [] };
    for (const source of ['global', 'project'] as const) {
      const selectedRoot = source === 'global' ? this.agentDir : projectRoot;
      if (!selectedRoot) continue;
      try {
        const root = await fs.promises.realpath(selectedRoot);
        const file = regularRulePath(root, source === 'global' ? 'hooks.json' : '.newai/hooks.json');
        const text = await readRuleText(file, signal);
        if (!text) continue;
        const entry: HookFile = { source, path: file, ...text, trusted: source === 'global' || this.trustStore.isTrusted(root, file, text.hash) };
        if (containsSensitiveContent(text.content)) { entry.content = ''; entry.error = 'Hooks 可能包含密钥或令牌，已拒绝加载'; }
        else { try { entry.config = validateHookConfig(JSON.parse(text.content)); } catch (error) { entry.error = error instanceof Error ? error.message : String(error); } }
        listing[source] = entry;
        if (entry.error) listing.diagnostics.push(source + '：' + entry.error);
        else if (!entry.trusted) listing.diagnostics.push('项目 Hooks 尚未信任');
      } catch (error) { signal?.throwIfAborted(); listing.diagnostics.push(source + ' Hooks 无法读取：' + (error instanceof Error ? error.message : String(error))); }
    }
    return listing;
  }

  async load(projectRoot?: string, signal?: AbortSignal): Promise<{ hooks: LoadedHook[]; diagnostics: string[] }> {
    const catalog = await this.list(projectRoot, signal);
    return { hooks: [catalog.global, catalog.project].flatMap((file) => file?.trusted && file.config && !file.error ? file.config.hooks.filter((hook) => hook.enabled !== false).map((hook) => ({ ...hook, source: file.source, path: file.path, hash: file.hash, key: file.source + ':' + hook.id })) : []), diagnostics: catalog.diagnostics };
  }

  async saveGlobal(input: unknown): Promise<HookConfig> {
    const config = validateHookConfig(input);
    const content = JSON.stringify(config, null, 2) + '\n';
    if (Buffer.byteLength(content) > 256 * 1024) throw new Error('Hooks 配置不能超过 256KB');
    if (containsSensitiveContent(content)) throw new Error('Hooks 配置可能包含密钥或令牌');
    atomicRuleWrite(regularRulePath(this.agentDir, 'hooks.json'), content);
    return config;
  }

  async trustProject(projectRoot: string, expectedHash: string): Promise<void> {
    projectRoot = await fs.promises.realpath(projectRoot);
    const file = (await this.list(projectRoot)).project;
    if (!file?.config || file.error) throw new Error(file?.error || '项目 Hooks 不存在或不可读取');
    if (file.hash !== expectedHash) throw new Error('Hooks 已变化，请重新查看后确认');
    this.trustStore.grant({ projectRoot, file: path.relative(projectRoot, file.path), sha256: file.hash });
  }
}
