import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { SearchChunk } from './SemanticChunks';

export interface IndexedFile { path: string; mtimeMs: number; size: number; hash: string; symbolHash: string; }
interface ChunkRow { id: string; path: string; line: number; end_line: number; signature: string | null; text: string; hash: string; vector: Buffer; }

const encode = (vector: number[]): Buffer => {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
};
const decode = (bytes: Buffer): number[] => Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readFloatLE(index * 4));

/** A project-local lexical and vector cache, independent of the symbol index. */
export class SemanticStore {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, symbol_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, path TEXT NOT NULL, line INTEGER NOT NULL, end_line INTEGER NOT NULL, signature TEXT, text TEXT NOT NULL, hash TEXT NOT NULL, vector BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
      CREATE TABLE IF NOT EXISTS embeddings (hash TEXT PRIMARY KEY, vector BLOB NOT NULL, touched_at INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED, path, signature, text);
    `);
  }

  setIdentity(identity: string): void {
    const previous = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('identity') as { value: string } | undefined;
    if (previous?.value === identity) return;
    this.db.transaction(() => {
      this.db.exec('DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM files; DELETE FROM embeddings; DELETE FROM meta;');
      this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('identity', identity);
    })();
  }

  files(): IndexedFile[] {
    return this.db.prepare('SELECT path, mtime_ms AS mtimeMs, size, hash, symbol_hash AS symbolHash FROM files').all() as IndexedFile[];
  }

  counts(): { indexedFiles: number; indexedChunks: number } {
    return { indexedFiles: (this.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n, indexedChunks: (this.db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n };
  }

  fileChunkCount(filePath: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM chunks WHERE path = ?').get(filePath) as { n: number }).n;
  }

  removeFile(filePath: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunks_fts WHERE path = ?').run(filePath);
      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(filePath);
      this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
    })();
  }

  saveFile(file: IndexedFile, chunks: SearchChunk[], vectors: number[][]): void {
    this.db.transaction(() => {
      this.removeFile(file.path);
      this.db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?)').run(file.path, file.mtimeMs, file.size, file.hash, file.symbolHash);
      const insert = this.db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const fts = this.db.prepare('INSERT INTO chunks_fts(id, path, signature, text) VALUES (?, ?, ?, ?)');
      for (const [index, chunk] of chunks.entries()) {
        insert.run(chunk.id, chunk.path, chunk.line, chunk.endLine, chunk.signature ?? null, chunk.text, chunk.hash, encode(vectors[index]));
        fts.run(chunk.id, chunk.path, chunk.signature ?? '', chunk.text);
      }
    })();
  }

  embedding(hash: string): number[] | undefined {
    const row = this.db.prepare('SELECT vector FROM embeddings WHERE hash = ?').get(hash) as { vector: Buffer } | undefined;
    if (!row) return undefined;
    this.db.prepare('UPDATE embeddings SET touched_at = ? WHERE hash = ?').run(Date.now(), hash);
    return decode(row.vector);
  }

  saveEmbedding(hash: string, vector: number[]): void {
    const dimensions = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('dimensions') as { value: string } | undefined;
    if (dimensions && Number(dimensions.value) !== vector.length) throw new Error('本机 embedding 模型的向量维度已改变，请重新选择模型');
    if (!dimensions) this.db.prepare('INSERT INTO meta VALUES (?, ?)').run('dimensions', String(vector.length));
    this.db.prepare('INSERT OR REPLACE INTO embeddings VALUES (?, ?, ?)').run(hash, encode(vector), Date.now());
  }

  pruneEmbeddings(): void {
    this.db.exec('DELETE FROM embeddings WHERE hash NOT IN (SELECT hash FROM chunks) AND hash NOT IN (SELECT hash FROM embeddings ORDER BY touched_at DESC LIMIT 1000)');
  }

  lexical(query: string, limit: number): string[] {
    const terms = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 24);
    if (!terms.length) return [];
    const match = terms.map((term) => '"' + term + '"').join(' OR ');
    return (this.db.prepare('SELECT id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?').all(match, limit) as { id: string }[]).map((row) => row.id);
  }

  *vectors(): Generator<{ id: string; vector: number[] }> {
    for (const row of this.db.prepare('SELECT id, vector FROM chunks').iterate() as Iterable<{ id: string; vector: Buffer }>) yield { id: row.id, vector: decode(row.vector) };
  }

  chunk(id: string): SearchChunk | undefined {
    const row = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(id) as ChunkRow | undefined;
    return row ? { id: row.id, path: row.path, line: row.line, endLine: row.end_line, signature: row.signature ?? undefined, text: row.text, hash: row.hash } : undefined;
  }

  close(): void { if (this.db.open) this.db.close(); }
}
