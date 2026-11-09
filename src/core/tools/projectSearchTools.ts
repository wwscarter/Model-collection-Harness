import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { createFindToolDefinition, createGrepToolDefinition, defineTool, truncateHead, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { collectProjectFiles, DEFAULT_MAX_FILE_BYTES, type ProjectFileCollection } from '@core/codebase/ProjectFiles';
import { isWithin, resolveAllowedPath } from './projectPaths';
import { locateRipgrep, searchWithRipgrep } from './RipgrepSearchBackend';
import { searchWithNode } from './NodeSearchBackend';
import type { ProjectSearchOptions, ProjectSearchRequest } from './projectSearchTypes';

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  return value === undefined ? fallback : Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : fallback;
}

function matchGlob(pattern: string | undefined): (name: string) => boolean {
  if (pattern === undefined) return () => true;
  if (!pattern || pattern.length > 512) throw new Error('文件 glob 需为 1–512 个字符');
  return picomatch(pattern, { dot: true, matchBase: true, nonegate: true, maxLength: 512 });
}

async function scopedFiles(root: string, requestedPath: string | undefined, glob: string | undefined, signal: AbortSignal): Promise<ProjectFileCollection> {
  const scope = resolveAllowedPath([root], requestedPath || '.');
  const stat = await fs.promises.stat(scope);
  const match = matchGlob(glob);
  const collection = await collectProjectFiles(root, { signal, scope });
  const base = stat.isDirectory() ? scope : path.dirname(scope);
  return {
    ...collection,
    files: collection.files.filter((file) => (stat.isDirectory() ? isWithin(scope, file.absolutePath) : file.absolutePath === scope) && match(path.relative(base, file.absolutePath).split(path.sep).join('/'))),
  };
}

function deadline(signal: AbortSignal | undefined, options: ProjectSearchOptions): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(10_000, options.timeoutMs ?? 10_000)));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Pi-compatible schemas/output with a local, filtered search backend. */
export function createProjectSearchTools(root: string, options: ProjectSearchOptions = {}): ToolDefinition[] {
  const find = defineTool({
    name: 'find', label: '查找项目文件',
    description: 'Find project files by glob, including ** and braces. Paths are relative to the project. Respects nested .gitignore, skips build output, sensitive files and symbolic links. Scans at most 5,000 files of up to 2MB each; narrow path when truncated.',
    promptSnippet: 'Find project files by glob before reading them',
    parameters: createFindToolDefinition(root).parameters,
    async execute(_id, input, signal) {
      const combined = deadline(signal, options);
      combined.throwIfAborted();
      const collection = await scopedFiles(root, input.path, input.pattern, combined);
      combined.throwIfAborted();
      const limit = Math.max(1, boundedInteger(input.limit, 200, 1_000));
      const limited = collection.files.length > limit;
      const output = truncateHead(collection.files.slice(0, limit).map((file) => file.path).join('\n') || 'No matching files.', { maxBytes: 7_600, maxLines: 1_000 });
      const truncated = collection.truncated || limited || output.truncated;
      return {
        content: [{ type: 'text', text: output.content + (truncated ? '\n\n[结果已截断；请缩小 path/glob 或调整 limit。]' : '') }],
        details: { scannedFiles: collection.files.length, truncated, truncation: output, resultLimitReached: limited ? limit : undefined },
      };
    },
  });
  const grep = defineTool({
    name: 'grep', label: '搜索项目内容',
    description: 'Search project text for a regex or literal string. Returns project-relative path:line:text; use read with offset/limit next. Respects nested .gitignore and excludes build output, sensitive files and symbolic links before reading. Defaults to 100 matching lines, at most 5,000 files / 2MB per file; max context 10, max limit 200. Uses bundled ripgrep or a local cancellable Node worker without downloading binaries.',
    promptSnippet: 'Search project content to locate relevant code',
    parameters: createGrepToolDefinition(root).parameters,
    async execute(_id, input, signal) {
      if (!input.pattern || input.pattern.length > 2_000) throw new Error('搜索模式需为 1–2000 个字符');
      const combined = deadline(signal, options);
      combined.throwIfAborted();
      const collection = await scopedFiles(root, input.path, input.glob, combined);
      const request: ProjectSearchRequest = {
        files: collection.files, pattern: input.pattern, literal: input.literal ?? false, ignoreCase: input.ignoreCase ?? false,
        context: boundedInteger(input.context, 0, 10), limit: Math.max(1, boundedInteger(input.limit, 100, 200)), maxFileBytes: DEFAULT_MAX_FILE_BYTES, signal: combined,
      };
      const binary = options.rgPath === undefined ? await locateRipgrep() : options.rgPath ?? undefined;
      combined.throwIfAborted();
      let result;
      try { result = binary ? await searchWithRipgrep(binary, request) : await searchWithNode(request); }
      catch (error) {
        if (binary && ['ENOENT', 'EACCES', 'ENOEXEC'].includes((error as NodeJS.ErrnoException).code ?? '')) result = await searchWithNode(request);
        else throw error;
      }
      combined.throwIfAborted();
      const body = result.lines.map((line) => line.path + (line.match ? ':' : '-') + line.line + (line.match ? ':' : '-') + line.text).join('\n') || 'No matches found.';
      const output = truncateHead(body, { maxBytes: 7_600, maxLines: 1_000 });
      const truncated = collection.truncated || result.truncated || output.truncated;
      return {
        content: [{ type: 'text', text: output.content + (truncated ? '\n\n[结果已截断；请缩小 path/glob、提高 limit 或读取命中行段。]' : '') }],
        details: { backend: result.backend, matches: result.matches, scannedFiles: collection.files.length, truncated, truncation: output, matchLimitReached: result.truncated && result.matches >= request.limit ? request.limit : undefined },
      };
    },
  });
  return [grep, find] as unknown as ToolDefinition[];
}
