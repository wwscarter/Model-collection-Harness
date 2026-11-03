import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BROWSER_USER_AGENT, decodeEntities, type FetchLike } from './search/SearchProvider';

export interface WebPage { url: string; title: string; content: string; truncated: boolean; contentType: string; }
export interface WebFetchOptions { fetchImpl?: FetchLike; resolveHost?: (host: string) => Promise<string[]>; maxBytes?: number; maxChars?: number; timeoutMs?: number; signal?: AbortSignal; }

const MAX_REDIRECTS = 5;

/** True for loopback, private, link-local, CGNAT, multicast and other non-public ranges. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (version === 6) {
    const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  }
  return true;
}

/** 198.18.0.0/15: the benchmarking range that fake-IP proxies hand out for every domain. */
export function isFakeIpAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address;
  if (isIP(mapped) !== 4) return false;
  const [a, b] = mapped.split('.').map(Number);
  return a === 198 && (b === 18 || b === 19);
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

/** Reject anything that is not a public http(s) URL. Checked again on every redirect hop. */
export async function assertPublicUrl(raw: string, resolveHost: (host: string) => Promise<string[]> = defaultResolve): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('网址无效'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只允许访问 http 或 https 网址');
  if (url.username || url.password) throw new Error('网址不能包含用户名或密码');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('不允许访问本机或内网地址');
  const literal = isIP(host) !== 0;
  const addresses = literal ? [host] : await resolveHost(host);
  // Proxies in fake-IP mode (Clash, Surge, sing-box TUN) answer every hostname with 198.18.0.0/15
  // and resolve the real name remotely. Accept that range for resolved names only, never literals.
  const blocked = (address: string) => isPrivateAddress(address) && (literal || !isFakeIpAddress(address));
  if (!addresses.length || addresses.some(blocked)) throw new Error('不允许访问本机或内网地址');
  return url;
}

/** Lightweight HTML → readable text. Keeps headings, list items, paragraphs and links. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = body
    .replace(/<(script|style|noscript|svg|iframe|template|head|nav|footer|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inner}\n\n`)
    .replace(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => { const label = inner.replace(/<[^>]+>/g, '').trim(); return label ? `${label} (${href})` : ''; })
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote|pre|main|header)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return {
    title,
    text: decodeEntities(text).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

async function readLimited(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) { chunks.push(value.subarray(0, maxBytes - total)); total = maxBytes; truncated = true; break; }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, truncated };
}

function charsetOf(contentType: string): string {
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/["']/g, '').toLowerCase();
  return charset && ['utf-8', 'utf8', 'gbk', 'gb2312', 'gb18030', 'big5', 'shift_jis', 'euc-kr', 'iso-8859-1', 'windows-1252'].includes(charset) ? charset : 'utf-8';
}

/** Fetch a public page with SSRF guards, size and time limits, and readable-text extraction. */
export async function fetchWebPage(rawUrl: string, options: WebFetchOptions = {}): Promise<WebPage> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const resolveHost = options.resolveHost ?? defaultResolve;
  const maxBytes = options.maxBytes ?? 2_000_000;
  const maxChars = options.maxChars ?? 20_000;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let url = await assertPublicUrl(rawUrl, resolveHost);
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    response = await fetchImpl(url.toString(), { redirect: 'manual', signal, headers: { 'user-agent': BROWSER_USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new Error(`重定向缺少目标地址（HTTP ${response.status}）`);
    if (hop === MAX_REDIRECTS) throw new Error('重定向次数过多');
    url = await assertPublicUrl(new URL(location, url).toString(), resolveHost);
  }
  if (!response) throw new Error('请求失败');
  if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !/text\/|json|xml|javascript/i.test(contentType)) throw new Error(`不支持的内容类型：${contentType.split(';')[0]}`);
  const { bytes, truncated: byteTruncated } = await readLimited(response, maxBytes);
  const raw = new TextDecoder(charsetOf(contentType)).decode(bytes);
  const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw);
  const { title, text } = isHtml ? htmlToText(raw) : { title: '', text: raw.trim() };
  const truncated = byteTruncated || text.length > maxChars;
  return { url: url.toString(), title, content: text.slice(0, maxChars), truncated, contentType };
}
