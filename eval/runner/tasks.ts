import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { EvalCheck, EvalTask } from './types';

export function fixturePath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative)) throw new Error('Fixture paths must be relative');
  const file = path.resolve(root, relative);
  const suffix = path.relative(root, file);
  if (suffix === '..' || suffix.startsWith('..' + path.sep)) throw new Error('Fixture path must remain inside its directory');
  return file;
}
export function snapshotFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Evaluation fixtures must contain ordinary files and directories');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        if (fs.statSync(file).size > 2 * 1024 * 1024 || files.size >= 5000) throw new Error('Evaluation fixture exceeds its size limit');
        files.set(path.relative(root, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
      }
    }
  };
  visit(root); return files;
}
function checkOf(raw: unknown): EvalCheck {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid evaluation check');
  const check = raw as Record<string, unknown>;
  const text = (key: string) => { if (typeof check[key] !== 'string' || !check[key]) throw new Error('Missing check ' + key); };
  const number = (key: string) => { if (typeof check[key] !== 'number' || !Number.isFinite(check[key]) || Number(check[key]) < 0) throw new Error('Invalid check ' + key); };
  switch (check.type) {
    case 'command': text('run'); if (!Number.isInteger(check.expectExit)) throw new Error('Invalid expected exit code'); break;
    case 'file-unchanged': text('path'); break;
    case 'file-contains': text('path'); text('value'); break;
    case 'answer-contains': text('value'); break;
    case 'max-tool-calls': case 'max-cost': number('value'); break;
    case 'llm-judge': text('modelId'); text('rubric'); number('minScore'); if (Number(check.minScore) > 1) throw new Error('Judge score must be between zero and one'); break;
    default: throw new Error('Unknown evaluation check');
  }
  return check as unknown as EvalCheck;
}
export function loadTasks(tasksDir: string, tags: string[] = [], smoke = false): EvalTask[] {
  const tasks: EvalTask[] = [];
  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(tasksDir, entry.name);
    const manifest = path.join(directory, 'task.json');
    if (!fs.existsSync(manifest)) continue;
    if (fs.statSync(manifest).size > 64_000) throw new Error('Evaluation manifest exceeds 64KB');
    const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (typeof value.id !== 'string' || !/^[a-z0-9-]+$/.test(value.id) || typeof value.prompt !== 'string' || !value.prompt.trim() || !Array.isArray(value.tags) || value.tags.some((tag: unknown) => typeof tag !== 'string')) throw new Error('Invalid evaluation manifest: ' + entry.name);
    if (!Array.isArray(value.checks) || !value.checks.length || value.checks.length > 50) throw new Error('Evaluation tasks need 1–50 checks');
    if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 30 * 60_000) throw new Error('Evaluation timeout must be 1 second–30 minutes');
    if (value.verificationMode !== undefined && !['off', 'quick', 'full'].includes(value.verificationMode)) throw new Error('Evaluation verificationMode must be off, quick or full');
    if (tags.length && !tags.some((tag) => value.tags.includes(tag))) continue;
    if (smoke && !fs.existsSync(path.join(directory, 'smoke.json'))) continue;
    const fixture = fixturePath(directory, value.fixture);
    if (!fs.statSync(fixture).isDirectory()) throw new Error('Fixture is not a directory');
    const checks = value.checks.map(checkOf);
    for (const check of checks) if ('path' in check) fixturePath(fixture, check.path);
    if (tasks.some((task) => task.id === value.id)) throw new Error('Duplicate evaluation id: ' + value.id);
    tasks.push({ id: value.id, tags: [...value.tags], prompt: value.prompt, fixture, checks, timeoutMs: value.timeoutMs, directory, verificationMode: value.verificationMode ?? 'quick' });
  }
  if (!tasks.length) throw new Error('No evaluation tasks match the selected tags/mode');
  return tasks;
}
