import Database from 'better-sqlite3';
import type { CodeSymbol, IndexedFile } from './CodebaseTypes';

export interface StoredFile { path: string; mtime: number; size: number; hash: string; }

export class IndexDatabase {
  private db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS symbols (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE, line INTEGER NOT NULL, endLine INTEGER NOT NULL, signature TEXT NOT NULL, exported INTEGER NOT NULL, language TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path);' +
      "CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, signature, path, content='symbols', content_rowid='id');" +
      'CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN INSERT INTO symbols_fts(rowid,name,signature,path) VALUES(new.id,new.name,new.signature,new.path); END;' +
      "CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN INSERT INTO symbols_fts(symbols_fts,rowid,name,signature,path) VALUES('delete',old.id,old.name,old.signature,old.path); END;" +
      "CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN INSERT INTO symbols_fts(symbols_fts,rowid,name,signature,path) VALUES('delete',old.id,old.name,old.signature,old.path); INSERT INTO symbols_fts(rowid,name,signature,path) VALUES(new.id,new.name,new.signature,new.path); END;",
    );
  }

  files(): Map<string, StoredFile> {
    const rows = this.db.prepare('SELECT path,mtime,size,hash FROM files').all() as StoredFile[];
    return new Map(rows.map((row) => [row.path, row]));
  }

  remove(paths: string[]): void {
    const remove = this.db.prepare('DELETE FROM files WHERE path = ?');
    this.db.transaction(() => { for (const filePath of paths) remove.run(filePath); })();
  }

  apply(files: IndexedFile[]): void {
    const metadata = this.db.prepare('INSERT INTO files(path,mtime,size,hash) VALUES(@path,@mtime,@size,@hash) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime,size=excluded.size,hash=excluded.hash');
    const remove = this.db.prepare('DELETE FROM symbols WHERE path = ?');
    const insert = this.db.prepare('INSERT INTO symbols(name,kind,path,line,endLine,signature,exported,language) VALUES(@name,@kind,@path,@line,@endLine,@signature,@exported,@language)');
    this.db.transaction(() => {
      for (const file of files) {
        metadata.run({ path: file.path, mtime: file.mtimeMs, size: file.size, hash: file.hash });
        remove.run(file.path);
        for (const symbol of file.symbols) insert.run({ ...symbol, exported: Number(symbol.exported) });
      }
    })();
  }

  count(): number { return (this.db.prepare('SELECT count(*) AS count FROM symbols').get() as { count: number }).count; }

  symbols(query: string, kind?: string, limit = 30): CodeSymbol[] {
    // Empty-query enumeration is also used internally for semantic chunk boundaries.
    const boundedLimit = Math.max(1, Math.min(query.trim() ? 200 : 100_000, Math.floor(Number.isFinite(limit) ? limit : 30)));
    const value = query.trim().slice(0, 256);
    const tokens = value.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    const params: Record<string, string | number> = { limit: boundedLimit, exact: value };
    const kindClause = kind ? kind === 'export' ? ' AND s.exported = 1' : ' AND s.kind = @kind' : '';
    if (kind && kind !== 'export') params.kind = kind;
    let rows: Array<Omit<CodeSymbol, 'exported'> & { exported: number }>;
    if (tokens.length) {
      params.match = tokens.map((token) => '"' + token + '"*').join(' AND ');
      rows = this.db.prepare('SELECT s.name,s.kind,s.path,s.line,s.endLine,s.signature,s.exported,s.language FROM symbols_fts JOIN symbols s ON s.id=symbols_fts.rowid WHERE symbols_fts MATCH @match' + kindClause + ' ORDER BY (s.name = @exact COLLATE NOCASE) DESC,bm25(symbols_fts,10,2,1),s.path,s.line LIMIT @limit').all(params) as typeof rows;
    } else {
      rows = this.db.prepare('SELECT s.name,s.kind,s.path,s.line,s.endLine,s.signature,s.exported,s.language FROM symbols s WHERE 1=1' + kindClause + ' ORDER BY s.path,s.line LIMIT @limit').all(params) as typeof rows;
    }
    return rows.map((row) => ({ ...row, exported: Boolean(row.exported) }));
  }

  close(): void { this.db.close(); }
}
