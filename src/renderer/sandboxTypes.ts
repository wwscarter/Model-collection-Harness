import type { SandboxSettings } from '@core/security/SandboxSettings';

export interface SandboxStatus { enabled: boolean; platform: string; reason?: string; }
export interface SandboxConfiguration { settings: SandboxSettings; status: SandboxStatus; }
export interface SandboxApi {
  get(): Promise<SandboxConfiguration>;
  set(settings: SandboxSettings): Promise<SandboxConfiguration>;
  pickDirectory(): Promise<string | undefined>;
}
