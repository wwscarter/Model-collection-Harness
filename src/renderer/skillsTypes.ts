export interface ManagedSkill { id: string; name: string; description: string; path: string; enabled: boolean; }
export interface SkillsListing { skills: ManagedSkill[]; diagnostics: string[]; }
export interface SkillImportPreview { name: string; content: string; fileCount: number; totalBytes: number; hash: string; }
export interface PendingSkillImport { token: string; preview: SkillImportPreview; }
export interface SkillsApi {
  list(): Promise<SkillsListing>;
  openDirectory(): Promise<unknown>;
  previewImport(): Promise<PendingSkillImport | undefined>;
  confirmImport(token: string): Promise<unknown>;
  setEnabled(id: string, enabled: boolean): Promise<unknown>;
}
