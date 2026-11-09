import fs from 'node:fs';
import path from 'node:path';
import type { LoadedMcpConfig, McpServerConfig } from '@earendil-works/pi-coding-agent';
import { decryptAPIKey, encryptAPIKey, type CredentialCodec } from '@utils/crypto';
import { atomicRuleWrite, MAX_RULE_BYTES, regularRulePath } from './RuleFiles';

export const MCP_SECRET_MASK = '••••••';
export interface McpServerView { name: string; config: McpServerConfig; error?: string }
export interface McpConfigListing { path: string; servers: McpServerView[]; diagnostics: string[] }
type RecordValue = Record<string, unknown>;
type Document = RecordValue & { mcpServers?: RecordValue; autoEnableCodemode?: boolean };
type SecretTransform = (value: unknown, location: string[]) => unknown;
const exposures = ['codemode', 'deferred', 'direct', 'hidden'];
const isRecord = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const encrypted = (value: unknown): value is { $encrypted: string } => isRecord(value) && Object.keys(value).length === 1 && typeof value.$encrypted === 'string';

function serverName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw new Error('MCP 名称需为 1–80 位字母、数字、横线或下划线');
  return value;
}
function text(value: unknown, label: string, max = 8192): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error('MCP ' + label + '无效');
  return value;
}
function exposure(value: unknown): string {
  const normalized = value === 'codemode-deferred' ? 'codemode' : value;
  if (typeof normalized !== 'string' || !exposures.includes(normalized)) throw new Error('MCP 工具公开方式无效');
  return normalized;
}
function knownFields(value: RecordValue, fields: string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error('MCP 配置包含不支持的字段');
}
function httpUrl(value: unknown, label: string): string {
  const url = text(value, label);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('MCP ' + label + '需使用 http 或 https'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('MCP ' + label + '需使用 http 或 https');
  if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some((key) => /(?:^|[_-])(?:token|key|secret|password|authorization|credential)(?:$|[_-])/i.test(key) || /^api[_-]?key$/i.test(key))) throw new Error('MCP URL 不能包含凭据，请在请求头中配置');
  return url;
}
function secretMap(value: unknown, field: string, transform: SecretTransform): RecordValue | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > 128) throw new Error('MCP ' + field + '需为最多 128 项的键值表');
  const entries = Object.entries(value).flatMap(([key, entry]) => {
    text(key, field + '名称', 120);
    if (field === 'env' ? !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) : !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw new Error('MCP ' + field + '名称格式无效');
    const result = transform(entry, [field, key]);
    return result === undefined ? [] : [[key, result]];
  });
  return Object.fromEntries(entries);
}

/** Validate only the public stdio/HTTP config shape; secret conversion is explicit. */
function configOf(raw: unknown, transform: SecretTransform): McpServerConfig {
  if (!isRecord(raw)) throw new Error('MCP 服务配置需为对象');
  const http = raw.type === 'http' || raw.type === 'streamable-http' || (raw.type === undefined && typeof raw.url === 'string');
  knownFields(raw, ['type', 'enabled', 'exposure', 'description', 'timeout', 'toolExposure', ...(http ? ['url', 'headers', 'auth', 'oauth'] : ['command', 'args', 'cwd', 'env'])]);
  const config: RecordValue = {};
  for (const key of ['enabled'] as const) if (raw[key] !== undefined) { if (typeof raw[key] !== 'boolean') throw new Error('MCP 启用状态无效'); config[key] = raw[key]; }
  if (raw.exposure !== undefined) config.exposure = exposure(raw.exposure);
  if (raw.description !== undefined) config.description = text(raw.description, '说明', 4000);
  if (raw.timeout !== undefined) { if (typeof raw.timeout !== 'number' || !Number.isFinite(raw.timeout) || raw.timeout <= 0 || raw.timeout > 3600) throw new Error('MCP 请求超时需为 0–3600 秒之间的正数'); config.timeout = raw.timeout; }
  if (raw.toolExposure !== undefined) {
    if (!isRecord(raw.toolExposure) || Object.keys(raw.toolExposure).length > 128) throw new Error('MCP 工具公开设置无效');
    config.toolExposure = Object.fromEntries(Object.entries(raw.toolExposure).map(([key, value]) => [text(key, '工具名称', 200), exposure(value)]));
  }
  if (http) {
    config.type = 'http'; config.url = httpUrl(raw.url, 'URL');
    const headers = secretMap(raw.headers, 'headers', transform);
    if (headers) config.headers = headers;
    if (raw.auth !== undefined) { if (!isRecord(raw.auth)) throw new Error('MCP 登录提供方无效'); knownFields(raw.auth, ['provider']); config.auth = { provider: text(raw.auth.provider, '登录提供方', 120) }; }
    if (raw.oauth !== undefined) {
      if (!isRecord(raw.oauth)) throw new Error('MCP OAuth 配置无效');
      knownFields(raw.oauth, ['clientId', 'clientSecret', 'callbackUrl', 'callbackPort', 'scope', 'clientName', 'authServerMetadataUrl', 'clientRegistration']);
      const oauth: RecordValue = {};
      for (const key of ['clientId', 'scope', 'clientName']) if (raw.oauth[key] !== undefined) oauth[key] = text(raw.oauth[key], 'OAuth 配置', 4000);
      for (const key of ['callbackUrl', 'authServerMetadataUrl']) if (raw.oauth[key] !== undefined) oauth[key] = httpUrl(raw.oauth[key], 'OAuth URL');
      if (raw.oauth.clientSecret !== undefined) { const value = transform(raw.oauth.clientSecret, ['oauth', 'clientSecret']); if (value !== undefined) oauth.clientSecret = value; }
      if (raw.oauth.callbackPort !== undefined) { if (!Number.isInteger(raw.oauth.callbackPort) || Number(raw.oauth.callbackPort) < 1 || Number(raw.oauth.callbackPort) > 65535) throw new Error('MCP OAuth 回调端口无效'); oauth.callbackPort = raw.oauth.callbackPort; }
      if (raw.oauth.clientRegistration !== undefined) { if (!['auto', 'dcr', 'cimd'].includes(String(raw.oauth.clientRegistration))) throw new Error('MCP OAuth 注册方式无效'); oauth.clientRegistration = raw.oauth.clientRegistration; }
      config.oauth = oauth;
    }
  } else {
    if (raw.type !== undefined && raw.type !== 'stdio') throw new Error('MCP 仅支持 stdio 与 HTTP 传输');
    config.type = 'stdio'; config.command = text(raw.command, '命令');
    if (raw.args !== undefined) { if (!Array.isArray(raw.args) || raw.args.length > 128 || raw.args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) throw new Error('MCP 参数需为最多 128 项的文本数组'); config.args = [...raw.args]; }
    if (raw.cwd !== undefined) config.cwd = text(raw.cwd, '工作目录', 4096);
    const env = secretMap(raw.env, 'env', transform);
    if (env) config.env = env;
  }
  return config as unknown as McpServerConfig;
}
function secretText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_384 || value.includes('\0')) throw new Error('MCP 凭据值需为不超过 16KB 的文本');
  return value;
}
function previousSecret(previous: unknown, location: string[]): unknown {
  let value = previous;
  for (const key of location) value = isRecord(value) ? value[key] : undefined;
  return value;
}

/** Renderer views are always masked; only load() can produce usable credentials. */
export class McpConfigStore {
  readonly filePath: string;
  private readonly agentDir: string;
  constructor(agentDir: string, private readonly codec: CredentialCodec = { encrypt: encryptAPIKey, decrypt: decryptAPIKey }) {
    fs.mkdirSync(agentDir, { recursive: true });
    this.agentDir = fs.realpathSync(agentDir);
    this.filePath = path.join(this.agentDir, 'mcp.json');
  }

  list(): McpConfigListing {
    const servers: McpServerView[] = [];
    const diagnostics: string[] = [];
    let document: Document;
    try { document = this.read(); } catch (error) { return { path: this.filePath, servers, diagnostics: [this.message(error)] }; }
    for (const [name, raw] of Object.entries(document.mcpServers ?? {})) {
      try {
        serverName(name);
        let credentialError = false;
        const config = configOf(raw, (value) => {
          if (encrypted(value)) { try { this.codec.decrypt(value.$encrypted); } catch { credentialError = true; } return MCP_SECRET_MASK; }
          return secretText(value) ? MCP_SECRET_MASK : undefined;
        });
        const error = credentialError ? 'MCP 凭据解密失败，请重新输入对应值' : undefined;
        servers.push({ name, config, ...(error ? { error } : {}) });
        if (error) diagnostics.push(name + '：' + error);
      } catch (error) { diagnostics.push(name + '：' + this.message(error)); }
    }
    return { path: this.filePath, servers, diagnostics };
  }

  save(name: string, draft: unknown): McpServerView {
    name = serverName(name);
    const document = this.read();
    const servers = { ...document.mcpServers };
    if (!(name in servers) && Object.keys(servers).length >= 64) throw new Error('MCP 服务最多 64 项');
    if (Object.keys(servers).some((other) => other !== name && other.replaceAll('-', '_') === name.replaceAll('-', '_'))) throw new Error('MCP 名称与已有工具命名空间重复');
    const previous = servers[name];
    servers[name] = configOf(draft, (value, location) => {
      if (value === MCP_SECRET_MASK) {
        const existing = previousSecret(previous, location);
        if (existing === undefined) throw new Error('此 MCP 凭据没有已保存值，请重新输入');
        return this.encode(existing);
      }
      return this.encode(value);
    });
    this.persist({ ...document, mcpServers: servers });
    return this.list().servers.find((server) => server.name === name)!;
  }

  remove(name: string): boolean {
    name = serverName(name);
    const document = this.read();
    const servers = { ...document.mcpServers };
    if (!Object.hasOwn(servers, name)) return false;
    delete servers[name]; this.persist({ ...document, mcpServers: servers });
    return true;
  }

  load(): LoadedMcpConfig {
    const result: LoadedMcpConfig = { servers: [], errors: [] };
    let document: Document;
    try { document = this.read(); } catch (error) { result.errors.push(this.message(error)); return result; }
    if (document.autoEnableCodemode !== undefined) result.autoEnableCodemode = document.autoEnableCodemode;
    for (const [name, raw] of Object.entries(document.mcpServers ?? {})) {
      try {
        serverName(name);
        const config = configOf(raw, (value) => {
          let plaintext: string;
          try { plaintext = encrypted(value) ? this.codec.decrypt(value.$encrypted) : secretText(value); } catch { throw new Error('MCP 凭据解密失败，请重新输入对应值'); }
          if (plaintext.startsWith('!')) throw new Error('MCP 凭据仅支持文字或环境变量引用，不运行配置中的命令');
          return plaintext || undefined;
        });
        if (result.servers.some((server) => server.name.replaceAll('-', '_') === name.replaceAll('-', '_'))) throw new Error('MCP 工具命名空间重复');
        result.servers.push({ name, config, source: this.filePath, scope: 'global' });
      } catch (error) { result.errors.push(name + '：' + this.message(error)); }
    }
    return result;
  }
  readonly loadConfig = (): LoadedMcpConfig => this.load();

  private encode(value: unknown): unknown {
    if (encrypted(value)) return { $encrypted: value.$encrypted };
    const plaintext = secretText(value);
    return plaintext ? { $encrypted: this.codec.encrypt(plaintext) } : undefined;
  }
  private read(): Document {
    regularRulePath(this.agentDir, 'mcp.json');
    let content: string;
    try {
      if (fs.statSync(this.filePath).size > MAX_RULE_BYTES) throw new Error('MCP 配置不能超过 256KB');
      content = fs.readFileSync(this.filePath, { encoding: 'utf8', flag: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('MCP 配置无法读取，请检查文件大小和权限'); }
    if (Buffer.byteLength(content, 'utf8') > MAX_RULE_BYTES || content.includes('\0')) throw new Error('MCP 配置需为不超过 256KB 的 JSON 文本');
    let value: unknown;
    try { value = JSON.parse(content.replace(/^\uFEFF/, '')); } catch { throw new Error('MCP 配置 JSON 格式无效'); }
    if (!isRecord(value) || (value.mcpServers !== undefined && !isRecord(value.mcpServers)) || (value.autoEnableCodemode !== undefined && typeof value.autoEnableCodemode !== 'boolean')) throw new Error('MCP 配置需包含 mcpServers 对象');
    if (isRecord(value.mcpServers) && Object.keys(value.mcpServers).length > 64) throw new Error('MCP 服务最多 64 项');
    return value as Document;
  }
  private persist(document: Document): void {
    const servers = Object.fromEntries(Object.entries(document.mcpServers ?? {}).map(([name, raw]) => [serverName(name), configOf(raw, (value) => this.encode(value))]));
    const content = JSON.stringify({ ...document, mcpServers: servers }, null, 2) + '\n';
    if (Buffer.byteLength(content, 'utf8') > MAX_RULE_BYTES) throw new Error('MCP 配置不能超过 256KB');
    atomicRuleWrite(regularRulePath(this.agentDir, 'mcp.json'), content);
  }
  private message(error: unknown): string { return error instanceof Error ? error.message : 'MCP 配置处理失败'; }
}
