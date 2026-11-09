import type { McpServerConfig } from '@earendil-works/pi-coding-agent';

export interface McpServerView { name: string; config: McpServerConfig; error?: string; }
export interface McpListing { path: string; servers: McpServerView[]; diagnostics: string[]; }
export interface McpTestResult { success: boolean; toolCount?: number; tools?: number | string[]; error?: string; }
export interface McpApi {
  list(): Promise<McpListing>;
  save(name: string, config: McpServerConfig): Promise<unknown>;
  remove(name: string): Promise<unknown>;
  test(name: string): Promise<McpTestResult>;
  log(): Promise<string[]>;
}
