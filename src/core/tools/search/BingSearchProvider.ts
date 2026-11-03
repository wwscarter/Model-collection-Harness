import { BROWSER_USER_AGENT, decodeEntities, stripTags, type FetchLike, type SearchOptions, type SearchProvider, type SearchResult } from './SearchProvider';

const RESULT_BLOCK = /<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>|$)/g;
const TITLE_LINK = /<h2[^>]*>\s*<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
const SNIPPET = /<p\b[^>]*>([\s\S]*?)<\/p>/;

/** Bing wraps some links as `/ck/a?...&u=a1<base64url>`; recover the real target. */
export function decodeBingUrl(raw: string): string | undefined {
  const href = decodeEntities(raw);
  try {
    const url = new URL(href, 'https://www.bing.com');
    if (url.hostname.endsWith('bing.com') && url.pathname.startsWith('/ck/')) {
      const encoded = url.searchParams.get('u');
      if (!encoded?.startsWith('a1')) return undefined;
      const target = Buffer.from(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      return /^https?:\/\//i.test(target) ? target : undefined;
    }
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch { return undefined; }
}

/** Parse Bing's HTML result page. Exported for tests; the markup changes over time. */
export function parseBingResults(html: string, limit = 10): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const block of html.match(RESULT_BLOCK) ?? []) {
    const link = TITLE_LINK.exec(block);
    if (!link) continue;
    const url = decodeBingUrl(link[1]);
    if (!url || seen.has(url)) continue;
    const title = stripTags(link[2]);
    if (!title) continue;
    const caption = block.slice(block.indexOf('</h2>') + 5);
    const snippet = stripTags(SNIPPET.exec(caption)?.[1] ?? '').replace(/^\d{4}年\d{1,2}月\d{1,2}日\s*·\s*/, '');
    seen.add(url);
    results.push({ title, url, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * Keyless search through Bing's public result page. cn.bing.com is tried first because it is
 * reachable in mainland China and returns direct links; www.bing.com is the fallback.
 * Scraping is best-effort: Bing may rate-limit or change markup, which is why the backend is pluggable.
 */
export class BingSearchProvider implements SearchProvider {
  readonly id = 'bing';
  readonly label = 'Bing（免 Key）';
  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init), private readonly hosts = ['cn.bing.com', 'www.bing.com']) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const count = Math.min(Math.max(options.count ?? 8, 1), 20);
    let lastError: unknown;
    for (const host of this.hosts) {
      try {
        const url = `https://${host}/search?q=${encodeURIComponent(query)}&count=${count}&form=QBLH`;
        const response = await this.fetchImpl(url, {
          headers: { 'user-agent': BROWSER_USER_AGENT, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', accept: 'text/html,application/xhtml+xml' },
          signal: options.signal,
          redirect: 'follow',
        });
        if (!response.ok) throw new Error(`Bing 返回 HTTP ${response.status}`);
        const results = parseBingResults(await response.text(), count);
        if (results.length) return results;
        lastError = new Error('Bing 没有返回可解析的结果');
      } catch (error) {
        if (options.signal?.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('搜索失败');
  }
}
