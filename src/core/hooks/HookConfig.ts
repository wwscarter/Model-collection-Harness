import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

const hookSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' }),
  event: Type.Union([Type.Literal('pre_tool'), Type.Literal('post_tool'), Type.Literal('run_start'), Type.Literal('run_end')]),
  enabled: Type.Optional(Type.Boolean()),
  match: Type.Optional(Type.Object({
    tool: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1, maxItems: 64 })),
    glob: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  }, { additionalProperties: false })),
  run: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  action: Type.Optional(Type.Literal('block')),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000 })),
  onFailure: Type.Optional(Type.Union([Type.Literal('report'), Type.Literal('ignore')])),
}, { additionalProperties: false });

export const HookConfigSchema = Type.Object({ version: Type.Literal(1), hooks: Type.Array(hookSchema, { maxItems: 64 }) }, { additionalProperties: false });
export type HookConfig = Static<typeof HookConfigSchema>;
export type HookDefinition = HookConfig['hooks'][number];
export type HookPhase = 'pre_tool' | 'post_tool' | 'run_start' | 'run_end';
export interface LoadedHook extends HookDefinition { source: 'global' | 'project'; path: string; hash: string; key: string }

/** File placeholders must be complete, unquoted shell words before quoting is applied. */
function validateTemplate(command: string): void {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; continue; }
    if (character === quote) { quote = ''; continue; }
    if (!quote && ["'", '"', '`'].includes(character)) { quote = character; continue; }
    if (command.startsWith('{{', index)) {
      if (!command.startsWith('{{files}}', index) || quote || (index > 0 && !/\s/.test(command[index - 1])) || (index + 9 < command.length && !/\s/.test(command[index + 9]))) throw new Error('Hook 只支持独立且未加引号的 {{files}} 占位符');
      index += 8;
    }
  }
}

export function validateHookConfig(value: unknown): HookConfig {
  if (!Check(HookConfigSchema, value)) throw new Error('Hooks 配置格式无效（version: 1，最多 64 条，超时 100–60000ms）');
  const config = value as HookConfig;
  const ids = new Set<string>();
  for (const hook of config.hooks) {
    if (ids.has(hook.id)) throw new Error('Hook ID 不能重复：' + hook.id);
    ids.add(hook.id);
    if (hook.action === 'block') {
      if (hook.event !== 'pre_tool' || hook.run || !hook.reason?.trim()) throw new Error('block Hook 只可用于 pre_tool，需提供 reason 且不能包含 run');
    } else if (!hook.run?.trim()) throw new Error('命令 Hook 需提供 run');
    if ((hook.event === 'run_start' || hook.event === 'run_end') && hook.match) throw new Error('运行生命周期 Hook 不支持工具匹配条件');
    if (hook.run) validateTemplate(hook.run);
  }
  return structuredClone(config);
}
