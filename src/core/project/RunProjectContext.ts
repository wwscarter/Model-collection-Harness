import type { ProjectStorage } from '../storage/ProjectStorage';
import { ProjectManager } from './ProjectManager';

/** Capture the conversation's project for one run, independently of the file panel. */
export function createRunProjectContext(
  projectId: string | null | undefined,
  storage: Pick<ProjectStorage, 'get'>,
): ProjectManager {
  const context = new ProjectManager();
  if (projectId == null) return context;
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('会话项目 ID 无效');
  const project = storage.get(projectId);
  if (!project) throw new Error('会话关联的项目已被移除，请重新关联项目');
  context.select(project.root);
  return context;
}
