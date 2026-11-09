export type ToolTrustMode = 'ask' | 'auto' | 'disabled';
export interface ManagedToolTrust { name: string; source: string; trust?: ToolTrustMode; }
export interface ToolTrustListing { tools: ManagedToolTrust[]; diagnostics: string[]; }
export interface ToolTrustApi {
  get(): Promise<ToolTrustListing>;
  set(name: string, trust: ToolTrustMode): Promise<unknown>;
}
