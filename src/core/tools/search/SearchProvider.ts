/** One normalized web result. Providers map their own formats onto this shape. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  count?: number;
  signal?: AbortSignal;
}

/**
 * Pluggable web search backend. Add a provider (SearXNG, Tavily, DeepSeek Search, ...)
 * by implementing this interface and registering it in `searchProviders`.
 */
export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»' };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
