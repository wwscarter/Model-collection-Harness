import { ProjectContext, type ProjectContextOptions, type ProjectContextResult, type ProjectNode } from './ProjectContext';

/** Keeps the selected project in the main process. The manager is intentionally in-memory;
 * selecting a project grants this app read-only context for the current run. */
export class ProjectManager {
  private context?: ProjectContext;

  select(root: string, options?: ProjectContextOptions): { root: string; name: string } {
    this.context = new ProjectContext(root, options);
    return this.context.getInfo();
  }

  clear(): void { this.context = undefined; }

  getInfo(): { root: string; name: string } | undefined { return this.context?.getInfo(); }

  getTree(relativePath?: string, maxDepth?: number): ProjectNode | undefined {
    return this.context?.listTree(relativePath, maxDepth);
  }

  getContext(relativePaths?: string[], maxTokens?: number): ProjectContextResult | undefined {
    return this.context?.buildContext(relativePaths, maxTokens);
  }

  /** Non-blocking variant used by the session execution path. */
  async getContextAsync(relativePaths?: string[], maxTokens?: number): Promise<ProjectContextResult | undefined> {
    return this.context?.buildContextAsync(relativePaths, maxTokens);
  }

  getRoot(): string | undefined { return this.context?.root; }
}
