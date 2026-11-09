import type { CodeSearchConfig } from '@core/codebase/CodeSearchConfig';
import type { CodeSearchResult } from '@core/codebase/SemanticSearch';

export interface CodebaseConfiguration { config: CodeSearchConfig; baseURL: string; status: CodeSearchResult; }
export interface CodebaseApi {
  get(): Promise<CodebaseConfiguration>;
  set(config: CodeSearchConfig): Promise<CodebaseConfiguration>;
  probe(config: CodeSearchConfig): Promise<{ model: string; digest: string }>;
  reindex(): Promise<{ files: number; symbols: number; durationMs: number; truncated: boolean }>;
}
