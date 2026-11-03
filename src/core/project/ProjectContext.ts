import fs from 'node:fs';
import path from 'node:path';

export interface ProjectNode {
  name: string;
  /** Project-relative POSIX path. The root node has an empty path. */
  path: string;
  kind: 'file' | 'directory';
  size?: number;
  children?: ProjectNode[];
}

export interface ProjectFile {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
}

export interface ProjectContextResult {
  root: string;
  files: ProjectFile[];
  text: string;
  tokenCount: number;
  truncated: boolean;
  skippedFiles: number;
}

export interface ProjectContextOptions {
  maxFileBytes?: number;
  maxFiles?: number;
  maxDepth?: number;
  maxContextTokens?: number;
  ignoreNames?: string[];
  ignorePatterns?: string[];
}

const DEFAULT_IGNORED_NAMES = new Set([
  '.git', '.hg', '.svn', '.DS_Store', 'node_modules', 'dist', 'build', 'out',
  'coverage', '.next', '.nuxt', '.cache', 'target', 'vendor', '__pycache__',
  '.venv', 'venv', 'Pods',
]);
const DEFAULT_SENSITIVE_NAMES = new Set(['.env', '.env.local', '.env.development', '.env.production', 'id_rsa', 'id_ed25519']);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.der']);
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx',
  '.json', '.jsx', '.md', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.swift', '.ts', '.tsx',
  '.toml', '.txt', '.vue', '.xml', '.yaml', '.yml', '.ini', '.conf', '.gitignore', '.log',
]);

function normalizeRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Safe, read-only project context reader. It never writes to the selected project and
 * rejects paths that escape the resolved project root (including symlinks).
 */
export class ProjectContext {
  readonly root: string;
  private readonly options: Required<Pick<ProjectContextOptions, 'maxFileBytes' | 'maxFiles' | 'maxDepth' | 'maxContextTokens'>> & Pick<ProjectContextOptions, 'ignoreNames' | 'ignorePatterns'>;
  private readonly ignoreNames: Set<string>;
  private readonly ignorePatterns: string[];

  constructor(root: string, options: ProjectContextOptions = {}) {
    if (!root || typeof root !== 'string') throw new Error('Project root is required');
    const resolved = fs.realpathSync(root);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) throw new Error('Project root must be a directory');
    this.root = resolved;
    this.options = {
      maxFileBytes: options.maxFileBytes ?? 256 * 1024,
      maxFiles: options.maxFiles ?? 200,
      maxDepth: options.maxDepth ?? 6,
      maxContextTokens: options.maxContextTokens ?? 8_000,
      ignoreNames: options.ignoreNames,
      ignorePatterns: options.ignorePatterns,
    };
    this.ignoreNames = new Set([...DEFAULT_IGNORED_NAMES, ...(options.ignoreNames ?? [])]);
    this.ignorePatterns = [...(options.ignorePatterns ?? []), ...this.loadGitignore()];
  }

  getInfo(): { root: string; name: string } {
    return { root: this.root, name: path.basename(this.root) || this.root };
  }

  listTree(relativePath = '', maxDepth = this.options.maxDepth): ProjectNode {
    const safePath = this.resolvePath(relativePath, true);
    const rootName = normalizeRelative(relativePath) ? path.basename(safePath) : path.basename(this.root) || this.root;
    return this.walkTree(safePath, normalizeRelative(relativePath), rootName, 0, Math.max(0, maxDepth));
  }

  readTextFile(relativePath: string): { content: string; truncated: boolean; size: number } {
    const safePath = this.resolvePath(relativePath, true);
    const stat = fs.statSync(safePath);
    if (!stat.isFile()) throw new Error('Only files can be read');
    const normalized = normalizeRelative(relativePath);
    if (this.isIgnored(normalized) || this.isSensitive(path.basename(safePath))) throw new Error('File is excluded from project context');
    const bytes = fs.readFileSync(safePath);
    if (!this.isText(normalized, bytes)) throw new Error('Binary files are excluded from project context');
    const limited = bytes.subarray(0, this.options.maxFileBytes);
    return { content: limited.toString('utf8'), truncated: bytes.length > limited.length, size: bytes.length };
  }

  buildContext(relativePaths?: string[], maxTokens = this.options.maxContextTokens): ProjectContextResult {
    const candidates = relativePaths?.length
      ? relativePaths.map(normalizeRelative).filter(Boolean)
      : this.collectTextFiles();
    const files: ProjectFile[] = [];
    let remainingChars = Math.max(1, Math.floor(maxTokens * 4));
    let skippedFiles = 0;
    let wasTruncated = false;
    for (const relative of candidates) {
      if (files.length >= this.options.maxFiles || remainingChars <= 0) { skippedFiles += 1; wasTruncated = true; continue; }
      try {
        const file = this.readTextFile(relative);
        const separator = files.length ? 1 : 0;
        const marker = `${separator ? "\n" : ""}--- FILE: ${relative} ---\n`;
        if (remainingChars <= marker.length) { skippedFiles += 1; wasTruncated = true; continue; }
        const suffixLength = '\n[truncated]'.length;
        const contentBudget = Math.max(0, remainingChars - marker.length - suffixLength);
        const content = file.content.slice(0, contentBudget);
        const truncated = file.truncated || content.length < file.content.length;
        files.push({ path: relative, size: file.size, content, truncated });
        remainingChars -= marker.length + content.length + (truncated ? suffixLength : 0);
        if (truncated) wasTruncated = true;
      } catch {
        skippedFiles += 1;
      }
    }
    const text = files.map((file, index) => `${index ? "\n" : ""}--- FILE: ${file.path} ---\n${file.content}${file.truncated ? '\n[truncated]' : ''}`).join('');
    return { root: this.root, files, text, tokenCount: estimateTokens(text), truncated: wasTruncated, skippedFiles };
  }

  private collectTextFiles(): string[] {
    const output: string[] = [];
    const visit = (directory: string, relativeDirectory: string, depth: number) => {
      if (output.length >= this.options.maxFiles || depth > this.options.maxDepth) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
      for (const entry of entries) {
        if (output.length >= this.options.maxFiles) break;
        const relative = normalizeRelative(path.join(relativeDirectory, entry.name));
        if (this.isIgnored(relative) || this.isSensitive(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute, relative, depth + 1);
        else if (entry.isFile()) {
          try {
            const sample = fs.readFileSync(absolute).subarray(0, Math.min(this.options.maxFileBytes, 8192));
            if (this.isText(relative, sample)) output.push(relative);
          } catch { /* inaccessible files are skipped */ }
        }
      }
    };
    visit(this.root, '', 0);
    return output;
  }

  private walkTree(absolute: string, relative: string, name: string, depth: number, maxDepth: number): ProjectNode {
    const stat = fs.statSync(absolute);
    if (!stat.isDirectory()) return { name, path: relative, kind: 'file', size: stat.size };
    const node: ProjectNode = { name, path: relative, kind: 'directory', children: [] };
    if (depth >= maxDepth) return node;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return node; }
    for (const entry of entries) {
      const childRelative = normalizeRelative(path.join(relative, entry.name));
      if (this.isIgnored(childRelative) || this.isSensitive(entry.name)) continue;
      const childAbsolute = path.join(absolute, entry.name);
      try {
        // Do not expose symlinks: resolving them can disclose files outside the project.
        if (entry.isSymbolicLink()) continue;
        node.children?.push(this.walkTree(childAbsolute, childRelative, entry.name, depth + 1, maxDepth));
      } catch { /* race or permission errors are omitted */ }
    }
    return node;
  }

  private resolvePath(relativePath: string, mustExist = true): string {
    const normalized = normalizeRelative(relativePath);
    if (!normalized || normalized === '.') return this.root;
    if (path.isAbsolute(relativePath) || normalized.split('/').some((segment) => segment === '..')) throw new Error('Path must stay inside the project root');
    const candidate = path.resolve(this.root, normalized);
    const resolved = mustExist ? fs.realpathSync(candidate) : candidate;
    const relative = path.relative(this.root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path must stay inside the project root');
    return resolved;
  }

  private isIgnored(relativePath: string): boolean {
    const segments = normalizeRelative(relativePath).split('/').filter(Boolean);
    if (segments.some((segment) => this.ignoreNames.has(segment))) return true;
    return this.ignorePatterns.some((pattern) => {
      const clean = pattern.trim().replace(/^\//, '').replace(/\/$/, '');
      if (!clean || clean.startsWith('#')) return false;
      if (clean.includes('*')) {
        const regex = new RegExp(`^${clean.split('*').map(escapeRegExp).join('.*')}(?:/|$)`);
        return regex.test(normalizeRelative(relativePath));
      }
      return normalizeRelative(relativePath) === clean || normalizeRelative(relativePath).startsWith(`${clean}/`) || segments.includes(clean);
    });
  }

  private isSensitive(name: string): boolean {
    const lower = name.toLowerCase();
    return DEFAULT_SENSITIVE_NAMES.has(lower) || SENSITIVE_EXTENSIONS.has(path.extname(lower));
  }

  private isText(relativePath: string, bytes: Buffer): boolean {
    if (bytes.includes(0)) return false;
    const extension = path.extname(relativePath).toLowerCase();
    if (TEXT_EXTENSIONS.has(extension) || path.basename(relativePath) === '.gitignore') return true;
    if (bytes.length === 0) return true;
    let control = 0;
    for (const byte of bytes.subarray(0, 8192)) if (byte < 7 || (byte > 14 && byte < 32)) control += 1;
    return control / Math.min(bytes.length, 8192) < 0.02;
  }

  private loadGitignore(): string[] {
    try { return fs.readFileSync(path.join(this.root, '.gitignore'), 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; }
  }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
