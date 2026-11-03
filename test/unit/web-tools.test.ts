import { describe, expect, it } from 'vitest';
import { BingSearchProvider, decodeBingUrl, parseBingResults, SearchProviderRegistry } from '../../src/core/tools/search';
import { assertPublicUrl, fetchWebPage, htmlToText, isPrivateAddress } from '../../src/core/tools/webFetch';

const bingHtml = `<ol id="b_results">
<li class="b_algo" data-id iid=SERP.1><div class="b_tpcn"><a class="tilk" href="https://zh.wikipedia.org/wiki/x">icon</a></div><h2><a target="_blank" href="https://zh.wikipedia.org/wiki/%E4%B8%8A%E6%B5%B7" h="ID=SERP,1">上海市 - <strong>维基百科</strong></a></h2><div class="b_caption"><p class="b_lineclamp2">2026年3月16日&ensp;&#0183;&ensp;上海是中国的直辖市 &amp; 经济中心</p></div></li>
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly9yZWFjdC5kZXYv&amp;ntb=1">React</a></h2><div class="b_caption"><p>The library for web</p></div></li>
<li class="b_algo"><h2><a href="javascript:alert(1)">bad</a></h2></li>
<li class="b_algo"><h2><a href="https://zh.wikipedia.org/wiki/%E4%B8%8A%E6%B5%B7">duplicate</a></h2></li>
</ol>`;

describe('Bing search provider', () => {
  it('parses titles, snippets and real URLs', () => {
    const results = parseBingResults(bingHtml);
    expect(results).toEqual([
      { title: '上海市 - 维基百科', url: 'https://zh.wikipedia.org/wiki/%E4%B8%8A%E6%B5%B7', snippet: '上海是中国的直辖市 & 经济中心' },
      { title: 'React', url: 'https://react.dev/', snippet: 'The library for web' },
    ]);
  });

  it('decodes Bing redirect links and rejects non-http targets', () => {
    expect(decodeBingUrl('https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9yZWFjdC5kZXYv')).toBe('https://react.dev/');
    expect(decodeBingUrl('javascript:alert(1)')).toBeUndefined();
  });

  it('falls back to the next host when the first fails', async () => {
    const hosts: string[] = [];
    const provider = new BingSearchProvider(async (input) => {
      hosts.push(new URL(input).hostname);
      return hosts.length === 1 ? new Response('blocked', { status: 503 }) : new Response(bingHtml, { status: 200 });
    });
    const results = await provider.search('上海', { count: 1 });
    expect(hosts).toEqual(['cn.bing.com', 'www.bing.com']);
    expect(results).toHaveLength(1);
  });

  it('times out a stalled host and tries the fallback', async () => {
    const hosts: string[] = [];
    const provider = new BingSearchProvider(async (input, init) => {
      hosts.push(new URL(input).hostname);
      if (hosts.length > 1) return new Response(bingHtml);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }, ['cn.bing.com', 'www.bing.com'], 20);
    await expect(provider.search('release notes')).resolves.toHaveLength(2);
    expect(hosts).toEqual(['cn.bing.com', 'www.bing.com']);
  });

  it('reports a timeout when all search hosts stall', async () => {
    const provider = new BingSearchProvider(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }), ['cn.bing.com'], 20);
    await expect(provider.search('release notes')).rejects.toThrow('联网搜索超时');
  });

  it('cancels a search without trying another host', async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider = new BingSearchProvider(async (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        controller.abort();
      });
    });
    await expect(provider.search('release notes', { signal: controller.signal })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('registry switches the active backend', () => {
    const registry = new SearchProviderRegistry([{ id: 'a', label: 'A', search: async () => [] }, { id: 'b', label: 'B', search: async () => [] }]);
    registry.setActive('b');
    expect(registry.getActive().id).toBe('b');
    expect(() => registry.setActive('nope')).toThrow();
  });
});

describe('web_fetch guards', () => {
  it('classifies private addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(address)).toBe(true);
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(isPrivateAddress(address)).toBe(false);
  });

  it('rejects local, private and non-http URLs', async () => {
    const publicDns = async () => ['93.184.216.34'];
    await expect(assertPublicUrl('file:///etc/passwd', publicDns)).rejects.toThrow('http');
    await expect(assertPublicUrl('http://localhost:3000', publicDns)).rejects.toThrow('内网');
    await expect(assertPublicUrl('http://192.168.1.10/', publicDns)).rejects.toThrow('内网');
    await expect(assertPublicUrl('http://user:pw@example.com/', publicDns)).rejects.toThrow('用户名');
    await expect(assertPublicUrl('http://rebind.example/', async () => ['127.0.0.1'])).rejects.toThrow('内网');
    await expect(assertPublicUrl('https://example.com/a', publicDns)).resolves.toBeInstanceOf(URL);
  });

  it('accepts fake-IP proxy answers for hostnames but not as literal addresses', async () => {
    await expect(assertPublicUrl('https://github.com/', async () => ['198.18.0.11'])).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://198.18.0.11/', async () => [])).rejects.toThrow('内网');
    await expect(assertPublicUrl('https://mixed.example/', async () => ['198.18.0.11', '10.0.0.1'])).rejects.toThrow('内网');
  });

  it('re-checks every redirect hop', async () => {
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    await expect(fetchWebPage('https://example.com/', { fetchImpl, resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow('内网');
  });

  it('extracts readable text and truncates long pages', async () => {
    const html = `<html><head><title>Demo &amp; Page</title><style>.x{}</style></head><body><nav>menu</nav><h1>Hello</h1><p>First <a href="https://a.example/">link</a></p><script>evil()</script><ul><li>one</li><li>two</li></ul></body></html>`;
    expect(htmlToText(html)).toEqual({ title: 'Demo & Page', text: '# Hello\n\nFirst link (https://a.example/)\n\n- one\n- two' });
    const page = await fetchWebPage('https://example.com/', { fetchImpl: async () => new Response(html + 'x'.repeat(500), { headers: { 'content-type': 'text/html; charset=utf-8' } }), resolveHost: async () => ['93.184.216.34'], maxChars: 40 });
    expect(page.title).toBe('Demo & Page');
    expect(page.truncated).toBe(true);
    expect(page.content.length).toBeLessThanOrEqual(40);
  });

  it('refuses binary content types', async () => {
    await expect(fetchWebPage('https://example.com/a.zip', { fetchImpl: async () => new Response('PK', { headers: { 'content-type': 'application/zip' } }), resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow('内容类型');
  });
});
