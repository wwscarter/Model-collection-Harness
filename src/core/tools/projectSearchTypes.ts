import type { ProjectFile } from '@core/codebase/ProjectFiles';

export interface SearchLine { path: string; line: number; text: string; match: boolean }
export interface ProjectSearchResult { lines: SearchLine[]; matches: number; truncated: boolean; backend: 'ripgrep' | 'node' }
export interface ProjectSearchRequest {
  files: ProjectFile[];
  pattern: string;
  literal: boolean;
  ignoreCase: boolean;
  context: number;
  limit: number;
  maxFileBytes: number;
  signal?: AbortSignal;
}
export interface ProjectSearchOptions { rgPath?: string | null; timeoutMs?: number }
