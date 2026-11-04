import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface TtySessionInfo {
  id: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  status: 'running' | 'closed';
  createdAt: Date;
  pid?: number;
}

export interface TtyProcessLike {
  pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event?: { exitCode?: number; signal?: number }) => void): void;
}

export type TtyProcessFactory = (shell: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => TtyProcessLike;
export interface CreateTtyOptions { id?: string; shell?: string; cwd?: string; cols?: number; rows?: number; env?: NodeJS.ProcessEnv; }
export interface TtyManagerOptions {
  defaultShell?: string;
  defaultCwd?: string;
  ptyFactory?: TtyProcessFactory;
  /** Off by default: a renderer must not be able to choose an arbitrary executable. */
  allowCustomShell?: boolean;
}

type DataListener = (data: string) => void;

/**
 * Manages isolated terminal sessions. node-pty is loaded only when available;
 * a child_process pipe adapter keeps development and tests usable without it.
 */
export class TtyManager {
  private readonly sessions = new Map<string, { info: TtySessionInfo; process: TtyProcessLike; listeners: Set<DataListener> }>();
  private readonly defaultShell: string;
  private readonly defaultCwd: string;
  private readonly injectedFactory?: TtyProcessFactory;
  private readonly allowCustomShell: boolean;
  private nativeFactoryPromise?: Promise<TtyProcessFactory | undefined>;

  constructor(options: TtyManagerOptions = {}) {
    this.defaultShell = options.defaultShell ?? (process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh'));
    this.defaultCwd = options.defaultCwd ?? process.cwd();
    this.injectedFactory = options.ptyFactory;
    this.allowCustomShell = options.allowCustomShell === true;
  }

  async createSession(options: CreateTtyOptions = {}): Promise<TtySessionInfo> {
    const shell = this.allowCustomShell && options.shell ? options.shell : this.defaultShell;
    const cwd = path.resolve(options.cwd ?? this.defaultCwd);
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error(`终端工作目录不存在：${cwd}`);
    }
    const cols = Math.max(20, Math.min(500, Math.floor(Number.isFinite(options.cols) ? options.cols! : 120)));
    const rows = Math.max(5, Math.min(300, Math.floor(Number.isFinite(options.rows) ? options.rows! : 36)));
    const id = options.id ?? randomUUID();
    if (this.sessions.has(id)) throw new Error(`TTY session already exists: ${id}`);
    const factory = this.injectedFactory ?? await this.loadNativeFactory() ?? this.createPipeFactory();
    // Never inherit process.env wholesale: it contains AMD_ENCRYPTION_KEY and
    // every API key in the user's shell. Only the variables a login shell needs.
    const terminal = factory(shell, process.platform === 'win32' ? [] : ['-i'], { name: 'xterm-256color', cols, rows, cwd, env: this.buildEnvironment(options.env) });
    const info: TtySessionInfo = { id, shell, cwd, cols, rows, status: 'running', createdAt: new Date(), pid: terminal.pid };
    const session = { info, process: terminal, listeners: new Set<DataListener>() };
    terminal.onData((data) => session.listeners.forEach((listener) => listener(data)));
    terminal.onExit(() => { info.status = 'closed'; });
    this.sessions.set(id, session);
    return this.cloneInfo(info);
  }

  getSession(id: string): TtySessionInfo | undefined { const session = this.sessions.get(id); return session ? this.cloneInfo(session.info) : undefined; }
  listSessions(): TtySessionInfo[] { return [...this.sessions.values()].map((session) => this.cloneInfo(session.info)); }

  write(id: string, data: string): void {
    if (typeof data !== 'string' || data.length > 100_000) throw new Error('终端输入无效或过长');
    this.requireSession(id).process.write(data);
  }
  resize(id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) throw new Error('终端尺寸无效');
    const session = this.requireSession(id);
    const nextCols = Math.max(20, Math.min(500, Math.floor(cols)));
    const nextRows = Math.max(5, Math.min(300, Math.floor(rows)));
    session.process.resize(nextCols, nextRows);
    session.info.cols = nextCols;
    session.info.rows = nextRows;
  }
  onData(id: string, listener: DataListener): () => void { const session = this.requireSession(id); session.listeners.add(listener); return () => session.listeners.delete(listener); }
  close(id: string, signal?: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.process.kill(signal);
    session.info.status = 'closed';
    session.listeners.clear();
    // Do not keep closed sessions in `list`; a long-running window would
    // accumulate dead entries and leak their output listeners.
    this.sessions.delete(id);
    return true;
  }
  dispose(): void { for (const id of [...this.sessions.keys()]) this.close(id); this.sessions.clear(); }

  private requireSession(id: string) { const session = this.sessions.get(id); if (!session) throw new Error(`TTY session not found: ${id}`); return session; }
  private cloneInfo(info: TtySessionInfo): TtySessionInfo { return { ...info, createdAt: new Date(info.createdAt) }; }

  private buildEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const allow = new Set([
      'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP',
      'TERM', 'TERM_PROGRAM', 'COLORTERM', 'SHELL', 'ComSpec', 'SystemRoot', 'PATHEXT', 'WINDIR',
      'NODE_ENV', 'PWD',
    ]);
    const env: NodeJS.ProcessEnv = {};
    for (const key of allow) if (process.env[key] !== undefined) env[key] = process.env[key];
    for (const [key, value] of Object.entries(overrides ?? {})) if (allow.has(key) && value !== undefined) env[key] = value;
    env.TERM = 'xterm-256color';
    env.HOME ||= os.homedir();
    return env;
  }

  private async loadNativeFactory(): Promise<TtyProcessFactory | undefined> {
    this.nativeFactoryPromise ??= (async () => {
      try {
        // Avoid statically resolving the optional native dependency in Vite/TypeScript builds.
        const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
        const nodePty = await dynamicImport('node-pty');
        return nodePty.spawn as TtyProcessFactory;
      } catch { return undefined; }
    })();
    return this.nativeFactoryPromise;
  }

  private createPipeFactory(): TtyProcessFactory {
    return (shell, args, options) => {
      const child = spawn(shell, args, { cwd: options.cwd, env: options.env, stdio: 'pipe', windowsHide: true }) as ChildProcessWithoutNullStreams;
      const dataListeners = new Set<(data: string) => void>();
      const exitListeners = new Set<(event?: { exitCode?: number; signal?: number }) => void>();
      child.stdout.on('data', (chunk: Buffer) => dataListeners.forEach((listener) => listener(chunk.toString('utf8'))));
      child.stderr.on('data', (chunk: Buffer) => dataListeners.forEach((listener) => listener(chunk.toString('utf8'))));
      child.on('exit', (exitCode, signal) => exitListeners.forEach((listener) => listener({ exitCode: exitCode ?? undefined, signal: signal ? os.constants.signals[signal] as unknown as number : undefined })));
      return { pid: child.pid, write: (data) => child.stdin.write(data), resize: () => undefined, kill: (signal) => child.kill(signal as NodeJS.Signals | undefined), onData: (listener) => { dataListeners.add(listener); }, onExit: (listener) => { exitListeners.add(listener); } };
    };
  }
}
