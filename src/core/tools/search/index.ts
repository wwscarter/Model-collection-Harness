import { BingSearchProvider } from './BingSearchProvider';
import type { SearchProvider } from './SearchProvider';

export * from './SearchProvider';
export { BingSearchProvider, parseBingResults, decodeBingUrl } from './BingSearchProvider';

/** Registry of search backends. Register more providers here (or from a plugin) without touching tool code. */
export class SearchProviderRegistry {
  private readonly providers = new Map<string, SearchProvider>();
  private activeId: string;

  constructor(initial: SearchProvider[] = [new BingSearchProvider()], activeId = initial[0]?.id ?? 'bing') {
    for (const provider of initial) this.register(provider);
    this.activeId = activeId;
  }

  register(provider: SearchProvider): void { this.providers.set(provider.id, provider); }
  list(): Array<{ id: string; label: string; active: boolean }> {
    return [...this.providers.values()].map((provider) => ({ id: provider.id, label: provider.label, active: provider.id === this.activeId }));
  }
  setActive(id: string): void {
    if (!this.providers.has(id)) throw new Error(`未知的搜索后端：${id}`);
    this.activeId = id;
  }
  getActive(): SearchProvider {
    const provider = this.providers.get(this.activeId) ?? this.providers.values().next().value;
    if (!provider) throw new Error('没有可用的搜索后端');
    return provider;
  }
}
