import fs from 'node:fs';
import { McpClient, StdioTransport, StreamableHttpTransport, type AuthProvider, type McpTransport } from '@earendil-works/pi-mcp';
import type { McpServerEntry } from '@earendil-works/pi-coding-agent';
import { createSandboxPolicy, wrapCommand, type SandboxMetadata, type SandboxPolicyResolver } from '@core/security/Sandbox';
import { resolveAllowedPath } from '@core/tools/projectPaths';
import { awaitWithSignal } from '@core/tools/awaitWithSignal';

export interface ConfiguredMcpTransport { transport: McpTransport; sandbox?: SandboxMetadata }
export interface McpTransportInput { entry: McpServerEntry; cwd: string; authProvider?: AuthProvider; sandboxPolicy?: SandboxPolicyResolver; onStderr?(text: string): void }
const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'ComSpec', 'COMSPEC', 'SystemRoot', 'SystemDrive', 'PATHEXT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramFiles'];
const RESERVED_ENV = new Set(['AMD_ENCRYPTION_KEY']);

/** Keep diagnostic notifications and transport errors safe before Pi persists them. */
function diagnosticTransport(transport: McpTransport, entry: McpServerEntry): McpTransport {
  const redact = (value: unknown): unknown => typeof value === 'string' ? redactMcpText(value, [entry])
    : Array.isArray(value) ? value.map(redact)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, field]) => [key, redact(field)])) : value;
  const safeError = (error: unknown) => new Error(redactMcpText(error instanceof Error ? error.message : String(error), [entry]));
  return {
    async start() { try { await transport.start(); } catch (error) { throw safeError(error); } },
    async send(message, options) { try { await transport.send(message, options); } catch (error) { throw safeError(error); } },
    close: () => transport.close(),
    onMessage: (listener) => transport.onMessage((message) => listener('method' in message && message.method === 'notifications/message' ? { ...message, params: redact(message.params) as Record<string, unknown> } : message)),
    onError: (listener) => transport.onError((error) => listener(safeError(error))),
    onClose: (listener) => transport.onClose(listener),
    setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
  };
}

function valueOf(value: string): string {
  if (value.startsWith('!')) throw new Error('MCP 凭据不能执行配置命令');
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
    if (RESERVED_ENV.has(key)) throw new Error('MCP 不可继承应用加密密钥');
    const resolved = process.env[key];
    if (resolved === undefined) throw new Error('MCP 引用的环境变量未配置：' + key);
    return resolved;
  });
}

/** Uses public Pi transports with app-owned config and platform command wrapping. */
export function createConfiguredMcpTransport(input: McpTransportInput): ConfiguredMcpTransport {
  const config = input.entry.config;
  if ('url' in config) return { transport: diagnosticTransport(new StreamableHttpTransport({ url: config.url, headers: Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key, valueOf(value)])), authProvider: input.authProvider, maxMessageBytes: 2 * 1024 * 1024 }), input.entry) };
  const root = fs.realpathSync(input.cwd);
  const cwd = config.cwd ? resolveAllowedPath([root], config.cwd) : root;
  if (!fs.statSync(cwd).isDirectory()) throw new Error('MCP 工作目录必须为项目目录');
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (process.platform === 'darwin') env.PATH = [...new Set([...(env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':'), '/opt/homebrew/bin', '/usr/local/bin'])].join(':');
  for (const [key, value] of Object.entries(config.env ?? {})) { if (RESERVED_ENV.has(key)) throw new Error('MCP 不可继承应用加密密钥'); env[key] = valueOf(value); }
  const wrapped = wrapCommand(config.command, config.args ?? [], (input.sandboxPolicy ?? createSandboxPolicy)(root), env);
  const configuredEnv = Object.fromEntries(Object.entries(wrapped.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]));
  return { transport: diagnosticTransport(new StdioTransport({ command: wrapped.command, args: wrapped.args, cwd, env: configuredEnv, inheritEnv: false, onStderr: input.onStderr, maxMessageBytes: 2 * 1024 * 1024, maxStderrBytes: 64 * 1024, closeTimeoutMs: 1000 }), input.entry), sandbox: wrapped.sandbox };
}

/** Connection tests only initialize and list the server's declared tools. */
export async function testMcpConnection(input: McpTransportInput, signal?: AbortSignal): Promise<{ tools: string[]; sandbox?: SandboxMetadata }> {
  const configured = createConfiguredMcpTransport(input);
  const client = new McpClient({ name: 'newai-connection-test', version: '1', requestTimeoutMs: 10_000 });
  const timeout = AbortSignal.timeout(10_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    await awaitWithSignal(client.connect(configured.transport), combined);
    const tools = await client.listTools({ signal: combined, timeoutMs: 10_000 });
    return { tools: tools.map((tool) => tool.name), sandbox: configured.sandbox };
  } finally { await client.close(); await configured.transport.close(); }
}

export function redactMcpText(text: string, entries: McpServerEntry[]): string {
  let redacted = text;
  const secrets: string[] = [];
  for (const entry of entries) {
    const config = entry.config;
    for (const secret of Object.values('url' in config ? config.headers ?? {} : config.env ?? {})) {
      if (secret) secrets.push(secret, ...secret.split(/\r?\n/));
      try { const expanded = valueOf(secret); if (expanded) secrets.push(expanded, ...expanded.split(/\r?\n/)); } catch { /* Unconfigured references have no plaintext to redact. */ }
    }
    if ('url' in config && config.oauth?.clientSecret) secrets.push(config.oauth.clientSecret);
  }
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) if (secret.length) redacted = redacted.replaceAll(secret, '[已隐藏]');
  return redacted;
}
