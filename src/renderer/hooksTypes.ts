import type { HookConfig } from '@core/hooks/HookConfig';

export interface HookFile {
  source: 'global' | 'project';
  path: string;
  content: string;
  hash: string;
  trusted: boolean;
  config?: HookConfig;
  error?: string;
}
export interface HooksListing { global?: HookFile; project?: HookFile; diagnostics: string[]; }
export interface HooksApi {
  list(): Promise<HooksListing>;
  saveGlobal(config: HookConfig): Promise<unknown>;
  trustProject(sha256: string): Promise<unknown>;
}
