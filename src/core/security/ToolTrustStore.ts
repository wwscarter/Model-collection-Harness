import fs from 'node:fs';
import { atomicRuleWrite } from '@core/agent/RuleFiles';

export type ToolTrust = 'ask' | 'auto' | 'disabled';
export const MODE_CONTROLLED_TOOLS = new Set(['run_command', 'write', 'edit']);
export function toolTrustName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_:./-]{0,199}$/.test(value)) throw new Error('工具名称无效');
  return value;
}

/** Overrides decide whether to ask; host-enforced project limits still apply. */
export class ToolTrustStore {
  readonly diagnostics: string[] = [];
  private entries: Record<string, ToolTrust> = {};
  constructor(private readonly filePath: string) {
    try {
      if (fs.statSync(filePath).size > 256 * 1024) throw new Error('工具信任配置超过容量');
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version?: unknown; tools?: unknown };
      if (parsed.version !== 1 || !parsed.tools || typeof parsed.tools !== 'object' || Array.isArray(parsed.tools)) throw new Error('工具信任配置格式无效');
      for (const [name, mode] of Object.entries(parsed.tools)) {
        toolTrustName(name);
        if (!['ask', 'auto', 'disabled'].includes(mode as string) || (mode === 'auto' && MODE_CONTROLLED_TOOLS.has(name))) throw new Error('工具信任配置无效');
        this.entries[name] = mode as ToolTrust;
      }
    } catch (error) {
      this.entries = {};
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.diagnostics.push('工具信任配置无法读取，已使用默认审批模式');
    }
  }
  list(): Record<string, ToolTrust> { return { ...this.entries }; }
  get(name: string): ToolTrust | undefined { return this.entries[name]; }
  set(name: unknown, mode: unknown): Record<string, ToolTrust> {
    const id = toolTrustName(name);
    if (!['ask', 'auto', 'disabled'].includes(mode as string)) throw new Error('工具信任须为 ask、auto 或 disabled');
    if (mode === 'auto' && MODE_CONTROLLED_TOOLS.has(id)) throw new Error('命令及文件修改工具由运行权限模式管理，不能设为自动允许');
    const tools = { ...this.entries, [id]: mode as ToolTrust };
    if (Object.keys(tools).length > 2000) throw new Error('工具信任项超过 2000 条');
    atomicRuleWrite(this.filePath, JSON.stringify({ version: 1, tools }, null, 2) + String.fromCharCode(10));
    this.entries = tools;
    this.diagnostics.length = 0;
    return this.list();
  }
}
