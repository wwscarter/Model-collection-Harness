export type RuleSource = 'global' | 'project' | 'session';
export interface RuleEntry { id: string; name: string; source: RuleSource; path: string; content: string; hash: string; enabled: boolean; trusted: boolean; blocked?: string; truncated?: boolean }
export interface RulesCatalog { global: RuleEntry[]; project: RuleEntry[]; session: RuleEntry[]; rules: RuleEntry[]; diagnostics: string[]; truncated: boolean }
export interface RulesLoadResult { rules: RuleEntry[]; diagnostics: string[]; truncated: boolean; usedChars: number }
export interface RulesInput { projectRoot?: string; sessionRules?: string; signal?: AbortSignal }
