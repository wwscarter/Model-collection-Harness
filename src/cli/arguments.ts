import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { ApprovalMode } from '@core/security/ApprovalPolicy';

export interface CliArguments {
  command: 'run' | 'models' | 'trace' | 'eval' | 'help';
  prompt?: string;
  runId?: string;
  project?: string;
  model?: string;
  dataDir: string;
  approval: ApprovalMode;
  json: boolean;
  yes: boolean;
  smoke: boolean;
  tags?: string[];
  baseline?: string;
  repeat: number;
  output?: string;
  tasksDir?: string;
  planningMode?: 'auto' | 'confirm' | 'only';
}

export const CLI_HELP = [
  'newai run "任务" --project . [--model id] [--approval ask|auto|full] [--json]',
  'newai models list [--json]',
  'newai trace show <runId> [--json]',
  'newai eval [--model id] [--tags code,fix] [--repeat 1] [--baseline report.json]',
  '',
  '通用选项：--data-dir <目录>（默认 ~/.newai）、--yes（允许需要确认的操作）、--help',
  '运行选项：--planning auto|confirm|only（默认 auto）',
  '评测选项：--tasks-dir <任务目录>、--output <结果目录>、--smoke（仅框架回放）',
  '凭据密钥：AMD_ENCRYPTION_KEY（32字节的hex或base64编码）',
].join('\n');

export function parseCliArguments(args: string[], homeDir = os.homedir()): CliArguments {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, smoke: { type: 'boolean' },
    project: { type: 'string' }, model: { type: 'string' }, approval: { type: 'string', default: 'ask' },
    'data-dir': { type: 'string' }, tags: { type: 'string' }, baseline: { type: 'string' },
    repeat: { type: 'string', default: '1' }, output: { type: 'string' }, 'tasks-dir': { type: 'string' }, planning: { type: 'string' },
  } });
  const command = values.help || positionals.length === 0 ? 'help' : positionals[0];
  if (!['run', 'models', 'trace', 'eval', 'help'].includes(command)) throw new Error('未知命令：' + command);
  if (!['ask', 'auto', 'full'].includes(values.approval!)) throw new Error('--approval 须为 ask、auto 或 full');
  if (values.planning !== undefined && !['auto', 'confirm', 'only'].includes(values.planning)) throw new Error('--planning 须为 auto、confirm 或 only');
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('--repeat 须为 1–20 的整数');
  const trailing = positionals.slice(1);
  if (command === 'run' && !trailing.join(' ').trim()) throw new Error('请提供运行任务，例如 newai run "修复类型错误" --project .');
  if (command === 'models' && (trailing.length !== 1 || trailing[0] !== 'list')) throw new Error('用法：newai models list');
  if (command === 'trace' && (trailing.length !== 2 || trailing[0] !== 'show' || !trailing[1]?.trim())) throw new Error('用法：newai trace show <runId>');
  if (command === 'eval' && trailing.length) throw new Error('用法：newai eval [--model id] [--tags code]');
  const resolveDirectory = (value: string) => path.resolve(value === '~' ? homeDir : value.startsWith('~/') ? path.join(homeDir, value.slice(2)) : value);
  return {
    command: command as CliArguments['command'], prompt: command === 'run' ? trailing.join(' ') : undefined,
    runId: command === 'trace' ? trailing[1] : undefined,
    project: values.project ? resolveDirectory(values.project) : undefined, model: values.model,
    dataDir: resolveDirectory(values['data-dir'] ?? path.join(homeDir, '.newai')), approval: values.approval as ApprovalMode,
    json: values.json ?? false, yes: values.yes ?? false, smoke: values.smoke ?? false, tags: values.tags?.split(',').map((tag) => tag.trim()).filter(Boolean),
    baseline: values.baseline ? path.resolve(values.baseline) : undefined, repeat,
    output: values.output ? path.resolve(values.output) : undefined, tasksDir: values['tasks-dir'] ? path.resolve(values['tasks-dir']) : undefined,
    planningMode: values.planning as CliArguments['planningMode'],
  };
}
