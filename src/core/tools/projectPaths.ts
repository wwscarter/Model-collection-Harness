import fs from 'node:fs';
import path from 'node:path';
import { isSensitiveRelativePath } from '@core/security/sensitiveFiles';

export function realOrSelf(target: string): string {
  try { return fs.realpathSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return target;
    // New files and nested directories do not exist yet. Resolve their existing parent first.
    const parent = path.dirname(target);
    return parent === target ? target : path.join(realOrSelf(parent), path.basename(target));
  }
}

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Resolve `target` (absolute, or relative to the first root) and require it to stay inside one of
 * `roots` after following symlinks. Files that commonly hold secrets are refused.
 */
export function resolveAllowedPath(roots: readonly string[], target: string): string {
  if (!roots.length) throw new Error('没有可访问的目录');
  const realRoots = roots.map(realOrSelf);
  const real = realOrSelf(path.resolve(realRoots[0], target));
  const containingRoot = realRoots.find((root) => isWithin(root, real));
  if (!containingRoot) throw new Error('只能访问当前项目目录（或已安装的技能目录）内的文件');
  const relative = path.relative(containingRoot, real);
  // Includes .git/: writing hooks or objects is a persistence primitive, and
  // .git/config can carry a remote URL with an access token.
  if (isSensitiveRelativePath(relative)) throw new Error('该文件可能包含密钥或属于版本库元数据，已拒绝访问');
  return real;
}

