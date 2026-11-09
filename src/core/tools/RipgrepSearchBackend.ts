import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ProjectFile } from '@core/codebase/ProjectFiles';
import type { ProjectSearchRequest, ProjectSearchResult } from './projectSearchTypes';

/** Resolve a bundled binary only. Searching never downloads executables. */
export async function locateRipgrep(): Promise<string | undefined> {
  const executable = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = resources ? [path.join(resources, 'ripgrep', executable), path.join(resources, 'ripgrep', 'bin', executable)] : [];
  if (resources) candidates.push(path.join(resources, 'ripgrep', 'ripgrep-' + process.platform + '-' + process.arch, 'bin', executable));
  try {
    const module = await import('@vscode/ripgrep');
    candidates.push(module.rgPath.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1'), module.rgPath);
  } catch { /* A missing optional binary uses the local Node fallback. */ }
  for (const candidate of candidates) {
    try {
      if (!(await fs.promises.stat(candidate)).isFile()) continue;
      await fs.promises.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return candidate;
    } catch { /* Try the next packaged location. */ }
  }
  return undefined;
}

function batches(files: ProjectFile[]): ProjectFile[][] {
  const result: ProjectFile[][] = [];
  let current: ProjectFile[] = [];
  let bytes = 0;
  for (const file of files) {
    const length = Buffer.byteLength(file.absolutePath) + 1;
    if (current.length && (current.length >= 64 || bytes + length > 24_000)) { result.push(current); current = []; bytes = 0; }
    current.push(file); bytes += length;
  }
  if (current.length) result.push(current);
  return result;
}

interface RipgrepEvent {
  type?: string;
  data?: { path?: { text?: string; bytes?: string }; line_number?: number; lines?: { text?: string; bytes?: string } };
}
const decode = (value?: { text?: string; bytes?: string }): string => value?.text ?? (value?.bytes ? Buffer.from(value.bytes, 'base64').toString('utf8') : '');

function searchBatch(binary: string, request: ProjectSearchRequest, files: ProjectFile[], result: ProjectSearchResult): Promise<void> {
  request.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const args = ['--no-config', '--json', '--hidden', '--no-ignore', '--color=never', '--line-number', '--threads', '1', '--max-filesize', String(request.maxFileBytes), '--max-count', String(request.limit + 1)];
    if (request.ignoreCase) args.push('--ignore-case');
    if (request.literal) args.push('--fixed-strings');
    if (request.context) args.push('--context', String(request.context));
    args.push('--', request.pattern, ...files.map((file) => file.absolutePath));
    const allowed = new Map(files.map((file) => [path.resolve(file.absolutePath), file.path]));
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const reader = createInterface({ input: child.stdout });
    let errorText = '';
    let outputBytes = 0;
    let outputChars = result.lines.reduce((total, line) => total + line.text.length + line.path.length + 20, 0);
    let stopped = false;
    let settled = false;
    let parseError: Error | undefined;
    const stop = () => { stopped = true; child.kill('SIGKILL'); reader.close(); };
    const onAbort = () => { stop(); finish(request.signal?.reason ?? new Error('搜索已取消')); };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      reader.close();
      request.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) { onAbort(); return; }
    child.stdout.on('data', (buffer: Buffer) => {
      outputBytes += buffer.length;
      if (outputBytes > 4 * 1024 * 1024) { result.truncated = true; stop(); }
    });
    child.stderr.on('data', (buffer: Buffer) => { if (errorText.length < 4_000) errorText += buffer.toString('utf8').slice(0, 4_000 - errorText.length); });
    reader.on('line', (line) => {
      if (stopped || settled) return;
      try {
        const message = JSON.parse(line) as RipgrepEvent;
        if (message.type !== 'match' && message.type !== 'context') return;
        const data = message.data;
        const relativePath = allowed.get(path.resolve(decode(data?.path)));
        if (!relativePath || !data?.line_number) return;
        if (message.type === 'match' && result.matches >= request.limit) { result.truncated = true; stop(); return; }
        if (message.type === 'match') result.matches++;
        const original = decode(data.lines).replace(/\r?\n$/, '');
        const text = original.length > 500 ? original.slice(0, 500) + ' [truncated]' : original;
        result.lines.push({ path: relativePath, line: data.line_number, text, match: message.type === 'match' });
        outputChars += relativePath.length + text.length + 20;
        if (outputChars > 16_000) { result.truncated = true; stop(); }
      } catch { parseError = new Error('无法解析 ripgrep 搜索结果'); stop(); }
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (request.signal?.aborted) finish(request.signal.reason ?? new Error('搜索已取消'));
      else if (parseError) finish(parseError);
      else if (!stopped && code !== 0 && code !== 1) finish(new Error(errorText.trim() || 'ripgrep 搜索失败：' + code));
      else finish();
    });
  });
}

export async function searchWithRipgrep(binary: string, request: ProjectSearchRequest): Promise<ProjectSearchResult> {
  const result: ProjectSearchResult = { lines: [], matches: 0, truncated: false, backend: 'ripgrep' };
  for (const files of batches(request.files)) {
    await searchBatch(binary, request, files, result);
    if (result.truncated) break;
  }
  return result;
}
