import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSandboxPolicy, sandboxFailureNotice, wrapCommand, type SandboxMetadata, type SandboxPolicyResolver } from '../security/Sandbox';

export interface ProjectCommandRequest {
  projectRoot: string;
  /** Session that started the process; used by the UI to offer cleanup after cancel. */
  sessionId?: string;
  command: string;
  background?: boolean;
  /** Foreground execution deadline, or background startup observation period. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Hook file arguments use PowerShell quoting on Windows. */
  shell?: 'powershell';
}

export interface ProjectProcessSnapshot {
  id: string;
  sessionId?: string;
  processId: string;
  pid?: number;
  command: string;
  cwd: string;
  background: boolean;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  running: boolean;
  stdout: string;
  stderr: string;
  output: string;
  urls: string[];
  exitCode: number | null;
  signal?: string;
  error?: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
  sandbox: SandboxMetadata;
}

interface ProcessState {
  info: ProjectProcessSnapshot;
  child: ChildProcess;
  startedAt: number;
  finishedAt?: number;
  completion: Promise<void>;
  finish: () => void;
  killTimer?: ReturnType<typeof setTimeout>;
  stopRequested: boolean;
  urlTail: string;
}

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CONCURRENT_PROCESSES = 16;
const MAX_FINISHED_PROCESSES = 50;
const DEFAULT_TIMEOUT_MS = 30_000;
const BACKGROUND_STARTUP_MS = 1_000;

function realDirectory(root: string): string {
  const real = fs.realpathSync(path.resolve(root));
  if (!fs.statSync(real).isDirectory()) throw new Error('项目路径不是目录');
  return real;
}

function tail(text: string, limit: number): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= limit ? text : bytes.subarray(bytes.length - limit).toString('utf8').replace(/^\uFFFD+/, '');
}

function commandEnvironment(cwd: string): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'TERM', 'SHELL', 'ComSpec', 'COMSPEC', 'SystemRoot', 'SystemDrive', 'PATHEXT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramFiles', 'NODE_ENV'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  // Finder-launched apps often inherit only the system PATH. Preserve explicit
  // tool choices while making the usual Homebrew/npm install locations visible.
  if (process.platform === 'darwin') {
    const directories = (env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(path.delimiter).filter(Boolean);
    env.PATH = [...new Set([...directories, '/opt/homebrew/bin', '/usr/local/bin'])].join(path.delimiter);
  }
  env.PWD = cwd;
  return env;
}

/**
 * Owns approved project commands across agent turns. The cwd is the selected
 * project; OS sandbox policy is applied whenever the platform supports it.
 * POSIX process groups (Windows taskkill /T) keep shell children in cleanup.
 */
export class ProjectProcessManager {
  private readonly processes = new Map<string, ProcessState>();
  private disposed = false;
  private readonly sandboxPolicy?: SandboxPolicyResolver;
  private readonly onAudit?: (event: { command: string; cwd: string; sessionId?: string; background: boolean; status: ProjectProcessSnapshot['status']; exitCode: number | null }) => void;

  constructor(options: { sandboxPolicy?: SandboxPolicyResolver; onAudit?: (event: { command: string; cwd: string; sessionId?: string; background: boolean; status: ProjectProcessSnapshot['status']; exitCode: number | null }) => void } = {}) {
    this.sandboxPolicy = options.sandboxPolicy;
    this.onAudit = options.onAudit;
  }

  async run(request: ProjectCommandRequest): Promise<ProjectProcessSnapshot> {
    if (this.disposed) throw new Error('进程管理器已关闭');
    if (request.signal?.aborted) throw new Error('命令已取消');
    const command = request.command?.trim();
    if (!command || command.length > 8_192) throw new Error('命令不能为空且不能超过 8192 个字符');
    if (request.sessionId !== undefined && (typeof request.sessionId !== 'string' || !request.sessionId || request.sessionId.length > 200)) throw new Error('会话 ID 无效');
    if (this.list().filter((process) => process.running).length >= MAX_CONCURRENT_PROCESSES) throw new Error('运行中的命令过多，请先停止不再使用的进程');
    const cwd = realDirectory(request.projectRoot);
    const background = request.background === true;
    const maximum = background ? 10_000 : 120_000;
    const requestedTimeout = request.timeoutMs ?? (background ? BACKGROUND_STARTUP_MS : DEFAULT_TIMEOUT_MS);
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) throw new Error('timeoutMs 必须是正数');
    const timeoutMs = Math.min(maximum, Math.max(50, Math.floor(requestedTimeout)));
    const state = this.start(command, cwd, background, request.shell);
    if (request.sessionId) state.info.sessionId = request.sessionId;
    const cancel = () => { state.info.cancelled = true; this.terminate(state); };
    request.signal?.addEventListener('abort', cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (request.signal?.aborted) cancel();
      if (background) {
        // A returned background process belongs to the manager, not to the
        // short-lived agent turn's AbortSignal. Its deadline observes startup.
        await Promise.race([state.completion, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
        if (state.info.cancelled) await state.completion;
        if (state.info.status === 'completed') {
          state.info.status = 'failed';
          state.info.error = '后台命令在启动观察期间已退出，没有持续运行的进程';
        }
      } else {
        timer = setTimeout(() => { state.info.timedOut = true; this.terminate(state); }, timeoutMs);
        await state.completion;
      }
      return this.snapshot(state);
    } finally {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener('abort', cancel);
    }
  }

  status(processId: string, projectRoot?: string): ProjectProcessSnapshot { return this.snapshot(this.require(processId, projectRoot)); }

  list(projectRoot?: string): ProjectProcessSnapshot[] {
    const cwd = projectRoot ? realDirectory(projectRoot) : undefined;
    return [...this.processes.values()].filter((state) => !cwd || state.info.cwd === cwd).map((state) => this.snapshot(state));
  }

  async stop(processId: string, projectRoot?: string): Promise<ProjectProcessSnapshot> {
    const state = this.require(processId, projectRoot);
    if (state.info.running) {
      state.stopRequested = true;
      this.terminate(state);
      await state.completion;
    }
    return this.snapshot(state);
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.processes.values()) {
      if (!state.info.running) continue;
      state.stopRequested = true;
      if (state.killTimer) clearTimeout(state.killTimer);
      this.signalTree(state, 'SIGKILL');
    }
  }

  private start(command: string, cwd: string, background: boolean, requestedShell?: 'powershell'): ProcessState {
    const id = randomUUID();
    const windows = process.platform === 'win32';
    const powershell = windows && requestedShell === 'powershell';
    const shell = powershell ? 'powershell.exe' : windows ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
    const args = powershell ? ['-NoProfile', '-NonInteractive', '-Command', command] : windows ? ['/d', '/s', '/c', command] : ['-c', command];
    const wrapped = wrapCommand(shell, args, (this.sandboxPolicy ?? createSandboxPolicy)(cwd), commandEnvironment(cwd));
    const child = spawn(wrapped.command, wrapped.args, {
      cwd, env: wrapped.env, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const info: ProjectProcessSnapshot = { id, processId: id, pid: child.pid, command, cwd, background, status: 'running', running: true, stdout: '', stderr: '', output: '', urls: [], exitCode: null, timedOut: false, cancelled: false, truncated: false, durationMs: 0, sandbox: wrapped.sandbox };
    const state: ProcessState = { info, child, startedAt: Date.now(), completion, finish, stopRequested: false, urlTail: '' };
    this.processes.set(id, state);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.append(state, 'stdout', chunk));
    child.stderr?.on('data', (chunk: string) => this.append(state, 'stderr', chunk));
    child.once('error', (error) => { info.error = error.message; this.finish(state, null); });
    child.once('exit', () => {
      // A command such as `server &` must not leave an untracked child behind
      // after its shell exits. Managed services use background: true instead.
      this.signalTree(state, 'SIGTERM');
      if (!state.killTimer) state.killTimer = setTimeout(() => this.signalTree(state, 'SIGKILL'), 750);
    });
    child.once('close', (code, signal) => this.finish(state, code, signal ?? undefined));
    this.prune();
    return state;
  }

  private append(state: ProcessState, stream: 'stdout' | 'stderr', text: string): void {
    const combined = state.info.output + text;
    if (Buffer.byteLength(combined, 'utf8') > MAX_OUTPUT_BYTES) state.info.truncated = true;
    state.info.output = tail(combined, MAX_OUTPUT_BYTES);
    state.info[stream] = tail(state.info[stream] + text, MAX_OUTPUT_BYTES / 2);
    const scan = state.urlTail + text.replace(/\u001b\[[0-9;]*m/g, '');
    for (const match of scan.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
      const candidate = match[0].replace(/[),.;]+$/, '');
      try {
        const url = new URL(candidate).toString();
        if (!state.info.urls.includes(url) && state.info.urls.length < 20) state.info.urls.push(url);
      } catch { /* An incomplete streamed URL is retried with the next chunk. */ }
    }
    state.urlTail = scan.slice(-4_096);
  }

  private finish(state: ProcessState, exitCode: number | null, signal?: string): void {
    if (!state.info.running) return;
    const notice = sandboxFailureNotice(state.info.stderr, state.info.sandbox);
    if (notice) this.append(state, 'stderr', '\n' + notice);
    state.finishedAt = Date.now();
    state.info.running = false;
    state.info.exitCode = exitCode;
    state.info.signal = signal;
    state.info.status = state.info.timedOut || state.info.error || (!state.info.cancelled && !state.stopRequested && exitCode !== 0)
      ? 'failed' : state.info.cancelled || state.stopRequested ? 'stopped' : 'completed';
    if (state.killTimer) clearTimeout(state.killTimer);
    this.signalTree(state, 'SIGKILL');
    state.finish();
    try { this.onAudit?.({ command: state.info.command, cwd: state.info.cwd, ...(state.info.sessionId ? { sessionId: state.info.sessionId } : {}), background: state.info.background, status: state.info.status, exitCode: state.info.exitCode }); }
    catch (error) { console.warn('[operation-audit] 记录命令执行失败', error instanceof Error ? error.message : error); }
    this.prune();
  }

  private terminate(state: ProcessState): void {
    if (!state.info.running) return;
    this.signalTree(state, 'SIGTERM');
    state.killTimer ??= setTimeout(() => this.signalTree(state, 'SIGKILL'), 750);
  }

  private signalTree(state: ProcessState, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!state.child.pid) return;
    if (process.platform === 'win32') {
      // /T includes npm and dev-server descendants, not just cmd.exe.
      spawnSync('taskkill', ['/pid', String(state.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5_000 });
      return;
    }
    try { process.kill(-state.child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') state.child.kill(signal); }
  }

  private require(processId: string, projectRoot?: string): ProcessState {
    const state = this.processes.get(processId);
    if (!state || (projectRoot && state.info.cwd !== realDirectory(projectRoot))) throw new Error(`当前项目中没有该进程：${processId}`);
    return state;
  }

  private snapshot(state: ProcessState): ProjectProcessSnapshot {
    return { ...state.info, sandbox: { ...state.info.sandbox }, urls: [...state.info.urls], durationMs: (state.finishedAt ?? Date.now()) - state.startedAt };
  }

  private prune(): void {
    const finished = [...this.processes.values()].filter((state) => !state.info.running);
    for (const state of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_PROCESSES))) this.processes.delete(state.info.id);
  }
}
