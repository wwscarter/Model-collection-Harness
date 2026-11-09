import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function displayPath(root: string): string {
  const home = os.homedir();
  return root === home || root.startsWith(home + path.sep) ? `~${root.slice(home.length)}` : root;
}

export function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${label}无效`);
  return value.trim();
}

export function resolveExistingRoot(value: unknown): string {
  const root = requireString(value, '项目目录', 4096);
  try { return fs.realpathSync(root); } catch { throw new Error(`项目目录不存在或已被移动：${displayPath(root)}`); }
}

export function normalizeProjectName(value: unknown): string {
  const name = requireString(value, '项目名称', 200).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name.length > 80) throw new Error('项目名称需为 1–80 个字符');
  return name;
}

