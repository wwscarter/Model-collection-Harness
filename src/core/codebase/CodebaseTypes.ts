export type CodeLanguage = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'rust' | 'java';
export type CodeSymbolKind = 'function' | 'class' | 'interface' | 'method' | 'type' | 'export';

export interface CodeSymbol {
  name: string;
  kind: CodeSymbolKind;
  path: string;
  line: number;
  endLine: number;
  signature: string;
  exported: boolean;
  language: CodeLanguage;
}

export interface IndexStats {
  projectRoot: string;
  files: number;
  indexed: number;
  unchanged: number;
  removed: number;
  symbols: number;
  durationMs: number;
  truncated: boolean;
  errors: string[];
}

export interface IndexFile {
  path: string;
  absolutePath: string;
  mtimeMs: number;
  size: number;
}

export interface IndexedFile extends IndexFile {
  hash: string;
  symbols: CodeSymbol[];
  truncated: boolean;
  error?: string;
}

export interface WorkerRequest { id: number; files: IndexFile[]; }
export interface WorkerResponse { id: number; files?: IndexedFile[]; error?: string; }

const LANGUAGES: Record<string, CodeLanguage> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python', go: 'go', rs: 'rust', java: 'java',
};

export function languageForPath(filePath: string): CodeLanguage | undefined {
  return LANGUAGES[filePath.split('.').at(-1)?.toLowerCase() ?? ''];
}
