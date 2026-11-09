import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { McpServerEntry } from '@earendil-works/pi-coding-agent';
import { redactMcpText, testMcpConnection } from '@core/agent/McpTransport';
import { mcpToolNames } from '@core/agent/McpToolNames';
import { createSandboxPolicy } from '@core/security/Sandbox';
import type { MainContext } from './MainContext';
import { confirmCommand } from './approvalPrompt';

const { quote } = createRequire(import.meta.url)('shell-quote') as { quote(values: string[]): string };
const partialLines = new WeakMap<McpServerEntry, { text: string; discarded: boolean }>();
const logPath = (ctx: MainContext) => path.join(ctx.agentRuntime.agentDir, 'mcp.log');

/** Persist complete redacted lines, so a credential split across chunks stays private. */
export function appendMcpLog(ctx: MainContext, entry: McpServerEntry, text: string): void {
  const previous = partialLines.get(entry) ?? { text: '', discarded: false };
  const lines = (previous.text + text).split(/\r?\n/);
  const remainder = lines.pop()!;
  const droppedFirst = previous.discarded;
  if (droppedFirst && lines.length) lines.shift();
  partialLines.set(entry, { text: remainder.length > 64 * 1024 ? '' : remainder, discarded: remainder.length > 64 * 1024 || (droppedFirst && !lines.length && !text.includes('\n')) });
  const safe = lines.map((line) => line.length > 64 * 1024 ? '[日志行超过容量限制]' : redactMcpText(line, [entry]).slice(0, 16_384));
  if (!safe.length) return;
  try {
    const file = logPath(ctx);
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.writeFileSync(file, readMcpLog(ctx).join('\n') + '\n', { mode: 0o600 });
    fs.appendFileSync(file, safe.map((line) => '[' + entry.name + '] ' + line).join('\n') + '\n', { mode: 0o600 });
  } catch { /* Logging cannot interrupt a model/tool request. */ }
}

export function readMcpLog(ctx: MainContext): string[] {
  const loaded = ctx.mcpConfig.load();
  if (loaded.errors.length) return ['MCP 配置尚未就绪，请处理配置诊断后读取日志。'];
  let handle: number | undefined;
  try {
    handle = fs.openSync(logPath(ctx), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) throw new Error('日志不是普通文件');
    const size = Math.min(128 * 1024, stat.size);
    const buffer = Buffer.alloc(size);
    const bytes = fs.readSync(handle, buffer, 0, size, Math.max(0, stat.size - size));
    const lines = buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/);
    if (stat.size > size) lines.shift();
    return redactMcpText(lines.filter(Boolean).slice(-200).join('\n'), loaded.servers).split('\n').filter(Boolean);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('MCP 日志无法读取'); }
  finally { if (handle !== undefined) fs.closeSync(handle); }
}

export async function testConfiguredMcp(ctx: MainContext, name: string): Promise<{ success: boolean; tools?: number; error?: string; sandbox?: unknown }> {
  const loaded = ctx.mcpConfig.load();
  const entry = loaded.servers.find((server) => server.name === name);
  if (!entry) throw new Error('MCP 服务未配置或凭据不可用，请先保存配置');
  const cwd = ctx.projects.getRoot() ?? ctx.workspaceRoot;
  if ('command' in entry.config && !(await confirmCommand(ctx, quote([entry.config.command, ...(entry.config.args ?? [])]), cwd, undefined, cwd))) return { success: false, error: '用户未批准 MCP 服务器连接' };
  try {
    const result = await testMcpConnection({ entry, cwd, sandboxPolicy: (root) => createSandboxPolicy(root, ctx.commandSandbox.settings), onStderr: (text) => appendMcpLog(ctx, entry, text) });
    const names = mcpToolNames(name, result.tools, loaded.servers.filter((server) => server.config.enabled !== false).map((server) => server.name));
    ctx.mcpTools.set(name, names);
    return { success: true, tools: result.tools.length, sandbox: result.sandbox };
  } catch (error) {
    ctx.mcpTools.delete(name);
    const text = redactMcpText(error instanceof Error ? error.message : String(error), loaded.servers).slice(0, 4000);
    appendMcpLog(ctx, entry, text + '\n');
    return { success: false, error: text };
  }
}
