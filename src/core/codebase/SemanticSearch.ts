import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveAllowedPath } from '@core/tools/projectPaths';
import { awaitWithSignal } from '@core/tools/awaitWithSignal';
import { validateRoutingBaseURL } from '@core/routing/RoutingSettings';
import { collectProjectFiles, type ProjectFile } from './ProjectFiles';
import { validateCodeSearchConfig, type CodeSearchConfig } from './CodeSearchConfig';
import { EmbeddingClient } from './EmbeddingClient';
import { chunkFile, contentHash, cosine, reciprocalRankFusion, type SearchSymbol } from './SemanticChunks';
import { SemanticStore } from './SemanticStore';

export interface CodeSearchHit { path: string; line: number; endLine: number; signature?: string; text: string; score: number; }
export interface CodeSearchResult { status: 'ready' | 'disabled' | 'unavailable'; reason?: string; model?: string; hits: CodeSearchHit[]; indexedFiles: number; indexedChunks: number; truncated: boolean; }
export interface CodeSearchOptions { signal?: AbortSignal; limit?: number; symbols?: SearchSymbol[]; config?: CodeSearchConfig; baseURL?: string; }
export interface SemanticSearchOptions { dataDir: string; getConfig(): CodeSearchConfig; getBaseURL(): string; fetch?: typeof fetch; }

/** Explicitly enabled local semantic retrieval; symbol lookup remains independent. */
export class SemanticSearch {
  private readonly stores = new Map<string, SemanticStore>();
  private readonly lifetime = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private status: CodeSearchResult = { status: 'disabled', reason: '代码语义检索尚未启用', hits: [], indexedFiles: 0, indexedChunks: 0, truncated: false };

  constructor(private readonly options: SemanticSearchOptions) {}

  getStatus(): CodeSearchResult { return structuredClone(this.status); }

  search(root: string, query: string, options: CodeSearchOptions = {}): Promise<CodeSearchResult> {
    const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    const job = this.queue.then(() => this.runSearch(root, query, { ...options, signal }));
    this.queue = job.then(() => undefined, () => undefined);
    return awaitWithSignal(job, signal);
  }

  close(): void {
    this.lifetime.abort(new Error('代码语义检索已关闭'));
    // A cancelled request may still be unwinding a file read; close after it settles.
    void this.queue.finally(() => { for (const store of this.stores.values()) store.close(); this.stores.clear(); });
  }

  private async runSearch(root: string, query: string, options: CodeSearchOptions): Promise<CodeSearchResult> {
    const signal = options.signal!;
    signal.throwIfAborted();
    let store: SemanticStore | undefined;
    let model: string | undefined;
    try {
      const config = validateCodeSearchConfig(options.config ?? this.options.getConfig());
      model = config.model || undefined;
      if (!config.enabled) return this.remember({ status: 'disabled', reason: '代码语义检索尚未启用', model, hits: [], indexedFiles: 0, indexedChunks: 0, truncated: false });
      if (typeof query !== 'string' || !query.trim() || query.length > 4_000) throw new Error('检索问题须为 1–4000 字符');
      if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 50)) throw new Error('检索数量须为 1–50 的整数');
      const baseURL = validateRoutingBaseURL(options.baseURL ?? this.options.getBaseURL());
      const client = new EmbeddingClient(baseURL, config.model, config.timeoutMs, this.options.fetch);
      const installed = await client.probe(signal);
      const canonicalRoot = await fs.promises.realpath(root);
      signal.throwIfAborted();
      store = this.store(canonicalRoot);
      store.setIdentity(baseURL + ':' + installed.model + ':' + installed.digest + ':chunks=' + config.maxChunks);
      const scan = await collectProjectFiles(canonicalRoot, { signal, maxFiles: config.maxFiles, maxFileBytes: 2 * 1024 * 1024 });
      const existing = new Map(store.files().map((file) => [file.path, file]));
      const activePaths = new Set(scan.files.map((file) => file.path));
      for (const file of existing.values()) if (!activePaths.has(file.path)) store.removeFile(file.path);
      const symbolsByPath = new Map<string, SearchSymbol[]>();
      for (const symbol of options.symbols ?? []) {
        const relative = symbol.path.replaceAll('\\', '/');
        const symbols = symbolsByPath.get(relative) ?? [];
        symbols.push(symbol); symbolsByPath.set(relative, symbols);
      }
      let chunkCount = store.counts().indexedChunks;
      let truncated = scan.truncated;
      for (const file of scan.files) {
        signal.throwIfAborted();
        const symbols = symbolsByPath.get(file.path) ?? [];
        const symbolHash = contentHash(JSON.stringify(symbols));
        const previous = existing.get(file.path);
        if (previous && previous.mtimeMs === file.mtimeMs && previous.size === file.size && previous.symbolHash === symbolHash) continue;
        const previousChunks = previous ? this.chunkCountForFile(store, file.path) : 0;
        const allowance = Math.max(0, config.maxChunks - chunkCount + previousChunks);
        const indexed = await this.indexFile(canonicalRoot, file, symbols, symbolHash, allowance, store, client, signal);
        chunkCount += indexed.count - previousChunks;
        truncated ||= indexed.truncated;
      }
      store.pruneEmbeddings();
      const queryVector = (await this.embeddings([query.trim()], store, client, signal))[0];
      const semantic: Array<{ id: string; score: number }> = [];
      let visited = 0;
      for (const chunk of store.vectors()) {
        if (++visited % 64 === 0) { await new Promise<void>((resolve) => setImmediate(resolve)); signal.throwIfAborted(); }
        const score = cosine(queryVector, chunk.vector);
        semantic.push({ id: chunk.id, score });
        semantic.sort((a, b) => b.score - a.score);
        if (semantic.length > 100) semantic.pop();
      }
      const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? config.topK)));
      const ranking = reciprocalRankFusion(store.lexical(query, 100), semantic.map((chunk) => chunk.id), limit);
      const hits = ranking.flatMap(({ id, score }) => { const chunk = store!.chunk(id); return chunk ? [{ path: chunk.path, line: chunk.line, endLine: chunk.endLine, signature: chunk.signature, text: chunk.text.slice(0, 2_000), score }] : []; });
      signal.throwIfAborted();
      return this.remember({ status: 'ready', model, hits, ...store.counts(), truncated });
    } catch (error) {
      signal.throwIfAborted();
      return this.remember({ status: 'unavailable', reason: error instanceof Error ? error.message : String(error), model, hits: [], ...(store?.counts() ?? { indexedFiles: 0, indexedChunks: 0 }), truncated: false });
    }
  }

  private store(root: string): SemanticStore {
    let store = this.stores.get(root);
    if (!store) {
      const identity = createHash('sha1').update(root).digest('hex');
      store = new SemanticStore(path.join(this.options.dataDir, 'index', 'semantic-' + identity + '.db'));
      this.stores.set(root, store);
    }
    return store;
  }

  private chunkCountForFile(store: SemanticStore, filePath: string): number {
    // Counting by the cached chunks avoids retaining full file contents in memory.
    return store.fileChunkCount(filePath);
  }

  private async indexFile(root: string, file: ProjectFile, symbols: SearchSymbol[], symbolHash: string, allowance: number, store: SemanticStore, client: EmbeddingClient, signal: AbortSignal): Promise<{ count: number; truncated: boolean }> {
    const resolved = resolveAllowedPath([root], file.absolutePath);
    const text = await fs.promises.readFile(resolved, { encoding: 'utf8', signal });
    const chunks = chunkFile(file.path, text, symbols);
    const selected = chunks.slice(0, allowance);
    const vectors = await this.embeddings(selected.map((chunk) => chunk.text), store, client, signal);
    signal.throwIfAborted();
    const current = await fs.promises.stat(resolveAllowedPath([root], file.absolutePath));
    if (current.mtimeMs !== file.mtimeMs || current.size !== file.size) { store.removeFile(file.path); return { count: 0, truncated: true }; }
    // A truncated file is reconsidered when capacity becomes available.
    store.saveFile({ path: file.path, mtimeMs: selected.length < chunks.length ? -1 : file.mtimeMs, size: file.size, hash: contentHash(text), symbolHash }, selected, vectors);
    return { count: selected.length, truncated: selected.length < chunks.length };
  }

  private async embeddings(texts: string[], store: SemanticStore, client: EmbeddingClient, signal: AbortSignal): Promise<number[][]> {
    const result: number[][] = new Array(texts.length);
    const missing = new Map<string, { text: string; indexes: number[] }>();
    for (const [index, text] of texts.entries()) {
      const hash = contentHash(text);
      const cached = store.embedding(hash);
      if (cached) result[index] = cached;
      else { const item = missing.get(hash) ?? { text, indexes: [] }; item.indexes.push(index); missing.set(hash, item); }
    }
    const pending = [...missing.entries()];
    for (let index = 0; index < pending.length; index += 16) {
      signal.throwIfAborted();
      const batch = pending.slice(index, index + 16);
      const vectors = await client.embed(batch.map(([, item]) => item.text), signal);
      signal.throwIfAborted();
      for (const [offset, [hash, item]] of batch.entries()) { store.saveEmbedding(hash, vectors[offset]); for (const position of item.indexes) result[position] = vectors[offset]; }
    }
    return result;
  }

  private remember(result: CodeSearchResult): CodeSearchResult { this.status = result; return structuredClone(result); }
}
