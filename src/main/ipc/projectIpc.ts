import { dialog, type OpenDialogOptions } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectProject } from '@core/project/ProjectInspector';
import { displayPath, requireString, resolveExistingRoot, normalizeProjectName } from '../paths';
import type { MainContext } from '../MainContext';
import { handle } from './register';

const execFileAsync = promisify(execFile);

function describeProject(ctx: MainContext, root: string) {
  const inspection = inspectProject(root);
  const record = ctx.projectStorage.getByRoot(inspection.root);
  return { ...inspection, id: record?.id, name: record?.name ?? inspection.suggestedName, displayRoot: displayPath(inspection.root) };
}

function openProjectRoot(ctx: MainContext, root: string, name?: string) {
  try {
    const info = ctx.projects.select(root);
    ctx.projectStorage.recordOpened(info.root, name);
    void ctx.codebase.refresh(info.root).catch((error) => console.warn('本地代码索引更新失败', error));
    return describeProject(ctx, info.root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`项目目录不存在或已被移动：${displayPath(root)}`);
    throw error;
  }
}

export function register(ctx: MainContext): void {
  const { projects, projectStorage, pickedProjectRoots } = ctx;
  handle('project:current', () => {
    const root = projects.getRoot();
    if (!root) return undefined;
    try { return describeProject(ctx, root); } catch { return { ...projects.getInfo()!, displayRoot: displayPath(root), languages: [], markers: [] }; }
  });
  handle('project:select', async (_event, requestedRoot?: unknown) => {
    if (requestedRoot !== undefined) {
      // Only roots the user already chose (dialog or stored list) may be reopened by path.
      const root = resolveExistingRoot(requestedRoot);
      if (!pickedProjectRoots.has(root) && !projectStorage.getByRoot(root)) throw new Error('请通过文件夹选择对话框选择项目目录');
      return openProjectRoot(ctx, root);
    }
    const options: OpenDialogOptions = { title: '选择项目文件夹', properties: ['openDirectory', 'createDirectory'] };
    const mainWindow = ctx.getWindow();
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return undefined;
    return openProjectRoot(ctx, selected.filePaths[0]);
  });
  handle('project:clear', () => { projects.clear(); return { success: true }; });
  handle('project:tree', (_event, options?: { path?: string; maxDepth?: number }) => projects.getTree(options?.path, options?.maxDepth));
  handle('project:context', async (_event, options?: { paths?: string[]; maxTokens?: number }) => projects.getContextAsync(options?.paths, options?.maxTokens));
  handle('project:file', (_event, relativePath: unknown) => {
    if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 1_000) throw new Error('文件路径无效');
    const file = projects.readFile(relativePath);
    if (!file) throw new Error('项目尚未打开或文件不存在');
    return file;
  });
  handle('project:init-git', async () => {
    const root = projects.getRoot();
    if (!root) throw new Error('请先选择项目');
    if (describeProject(ctx, root).git) return describeProject(ctx, root);
    try {
      await execFileAsync('git', ['init'], { cwd: root, timeout: 15_000, windowsHide: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error('无法创建 Git 存储库：' + message);
    }
    projectStorage.recordOpened(root);
    return describeProject(ctx, root);
  });
  handle('projects:list', () => {
    const activeRoot = projects.getRoot();
    return projectStorage.list().map((project) => ({ ...project, displayRoot: displayPath(project.root), active: project.root === activeRoot }));
  });
  handle('projects:open', (_event, id: unknown) => {
    const project = projectStorage.get(requireString(id, '项目 ID', 100));
    if (!project) throw new Error('项目记录不存在，请刷新列表');
    return openProjectRoot(ctx, project.root);
  });
  handle('projects:remove', (_event, id: unknown) => {
    const project = projectStorage.get(requireString(id, '项目 ID', 100));
    if (!project) return { success: false };
    if (projects.getRoot() === project.root) projects.clear();
    return { success: projectStorage.remove(project.id) };
  });
  handle('projects:pick-directory', async () => {
    const options: OpenDialogOptions = { title: '选择要绑定的项目文件夹', buttonLabel: '选择', properties: ['openDirectory', 'createDirectory'] };
    const mainWindow = ctx.getWindow();
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return undefined;
    const info = describeProject(ctx, selected.filePaths[0]);
    pickedProjectRoots.add(info.root);
    return { ...info, existing: Boolean(info.id) };
  });
  handle('projects:create', (_event, input: unknown) => {
    const { root, name } = (input ?? {}) as { root?: unknown; name?: unknown };
    const resolved = resolveExistingRoot(root);
    if (!pickedProjectRoots.has(resolved) && !projectStorage.getByRoot(resolved)) throw new Error('请通过文件夹选择对话框选择项目目录');
    return openProjectRoot(ctx, resolved, normalizeProjectName(name));
  });
}
