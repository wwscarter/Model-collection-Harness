export interface RuleEntry {
  id?: string;
  source?: 'global' | 'project' | 'session';
  name: string;
  path: string;
  content: string;
  hash: string;
  enabled: boolean;
  trusted: boolean;
  blocked?: string;
}
export interface RulesListing {
  global: RuleEntry[];
  project: RuleEntry[];
  diagnostics: string[];
  truncated: boolean;
}
export interface GlobalRuleDraft { name: string; content: string; enabled: boolean; }
export interface RulesApi {
  list(): Promise<RulesListing>;
  saveGlobal(rule: GlobalRuleDraft): Promise<unknown>;
  setEnabled(name: string, enabled: boolean): Promise<unknown>;
  trustProject(path: string, sha256: string): Promise<unknown>;
  removeGlobal(name: string): Promise<unknown>;
}
