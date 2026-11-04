import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export interface CommandExecutionRequest {
  /** The command is run by the platform shell only after `approved` is true. */
  command: string;
  /** Required project boundary. Every process and its cwd stays below this path. */
  projectRoot: string;
  cwd?: string;
  approved?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string | undefined>;
}

export interface CommandExecutionResult {
  id: string;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface CommandExecutionData {
  stream: 'stdout' | 'stderr';
  data: string;
}

interface ExecutionState {
  id: string;
  child: ChildProcess;
  promise: Promise<CommandExecutionResult>;
  listeners: Set<(event: CommandExecutionData) => void>;
  cancel: () => void;
}

type SpawnFunction = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; windowsHide: boolean; detached: boolean }) => ChildProcess;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Execute an explicitly approved command inside a selected project directory.
 * This is deliberately separate from the interactive TTY: model output never
 * reaches this class, and callers must opt in with `approved: true`.
 */
export class CommandExecutor {
  private readonly executions = new Map<string, ExecutionState>();
  private readonly injectedSpawn?: SpawnFunction;
  private readonly defaultProjectRoot?: string;

  constructor(options: { spawn?: SpawnFunction; defaultProjectRoot?: string } = {}) {
    this.injectedSpawn = options.spawn;
    this.defaultProjectRoot = options.defaultProjectRoot;
  }

  run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    try { return this.start(request).promise; }
    catch (error) { return Promise.reject(error); }
  }

  start(request: CommandExecutionRequest): { id: string; promise: Promise<CommandExecutionResult> } {
    const normalized = this.normalizeRequest(request);
    if (!normalized.approved) throw new Error('Command execution requires explicit approval');
    const id = randomUUID();
    const windows = process.platform === 'win32';
    const shell = windows ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
    const shellArgs = windows ? ['/d', '/s', '/c', normalized.command] : ['-c', normalized.command];
    const environment = this.buildEnvironment(normalized.env);
    environment.PWD = normalized.cwd;
    const child = (this.injectedSpawn ?? spawnProcess)(shell, shellArgs, {
      cwd: normalized.cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // A POSIX process group lets cancellation kill shell children too. Windows
      // is handled with taskkill /T below.
      detached: !windows,
    });
    const listeners = new Set<(event: CommandExecutionData) => void>();
    let stdout = '';
    let stderr = '';
    let output = '';
    let totalBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let truncated = false;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    let resolveResult!: (result: CommandExecutionResult) => void;
    let rejectResult!: (error: Error) => void;
    const promise = new Promise<CommandExecutionResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });

    const finish = (exitCode: number | null, signal?: NodeJS.Signals | string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      this.executions.delete(id);
      resolveResult({ id, command: normalized.command, cwd: normalized.cwd, stdout, stderr, output, exitCode, signal: signal ? String(signal) : undefined, timedOut, cancelled, truncated, durationMs: Date.now() - startedAt });
    };

    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) { try { child.kill(signal); } catch { /* already exited */ } return; }
      if (windows) {
        // taskkill /T terminates the whole tree, including npm/node grandchildren.
        try { spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { try { child.kill(signal); } catch { /* ignore */ } }
        return;
      }
      try { process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch { /* already exited */ } }
    };

    const terminate = () => {
      if (settled) return;
      killTree('SIGTERM');
      // Give the tree a short grace period, then force it. The settle timer also
      // guarantees the promise resolves even if a grandchild keeps the pipes open.
      killTimer ??= setTimeout(() => killTree('SIGKILL'), 750);
      settleTimer ??= setTimeout(() => finish(null, 'SIGKILL'), 3_000);
    };

    const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (settled || truncated) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      const remaining = normalized.maxOutputBytes - totalBytes;
      const bytes = Buffer.byteLength(text, 'utf8');
      const accepted = bytes <= remaining ? text : new TextDecoder().decode(Buffer.from(text, 'utf8').subarray(0, Math.max(0, remaining)), { stream: true });
      totalBytes += Buffer.byteLength(accepted, 'utf8');
      if (stream === 'stdout') stdout += accepted;
      else stderr += accepted;
      output += accepted;
      if (accepted) listeners.forEach((listener) => listener({ stream, data: accepted }));
      if (bytes > remaining) {
        truncated = true;
        // Stop a process that keeps producing output; this is a resource limit,
        // not a successful completion.
        terminate();
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => append('stderr', chunk));

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      this.executions.delete(id);
      rejectResult(error instanceof Error ? error : new Error(String(error)));
    });
    child.once('close', (code, signal) => finish(code, signal ?? undefined));
    const cancel = () => {
      if (settled) return;
      cancelled = true;
      terminate();
    };
    const state: ExecutionState = { id, child, promise, listeners, cancel };
    this.executions.set(id, state);
    timer = setTimeout(() => { if (!settled) { timedOut = true; terminate(); } }, normalized.timeoutMs);
    return { id, promise };
  }

  cancel(id: string): boolean {
    const execution = this.executions.get(id);
    if (!execution) return false;
    execution.cancel();
    return true;
  }

  onData(id: string, listener: (event: CommandExecutionData) => void): () => void {
    const execution = this.executions.get(id);
    if (!execution) throw new Error(`Command execution not found: ${id}`);
    execution.listeners.add(listener);
    return () => execution.listeners.delete(listener);
  }

  dispose(): void {
    for (const execution of this.executions.values()) execution.cancel();
    this.executions.clear();
  }

  private normalizeRequest(request: CommandExecutionRequest): Required<Pick<CommandExecutionRequest, 'command' | 'projectRoot' | 'cwd' | 'approved' | 'timeoutMs' | 'maxOutputBytes'>> & Pick<CommandExecutionRequest, 'env'> {
    const command = request.command?.trim();
    if (!command) throw new Error('Command cannot be empty');
    if (command.length > 8_192) throw new Error('Command is too long');
    const rootInput = request.projectRoot || this.defaultProjectRoot;
    if (!rootInput) throw new Error('A project root is required');
    const projectRoot = this.realDirectory(rootInput, 'Project root');
    const cwdInput = request.cwd ? (path.isAbsolute(request.cwd) ? request.cwd : path.join(projectRoot, request.cwd)) : projectRoot;
    const cwd = this.realDirectory(cwdInput, 'Working directory');
    const relative = path.relative(projectRoot, cwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Working directory must stay inside the project root');
    const rawTimeout = request.timeoutMs === undefined || !Number.isFinite(request.timeoutMs) ? DEFAULT_TIMEOUT_MS : request.timeoutMs;
    const rawOutput = request.maxOutputBytes === undefined || !Number.isFinite(request.maxOutputBytes) ? DEFAULT_MAX_OUTPUT_BYTES : request.maxOutputBytes;
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(rawTimeout)));
    const maxOutputBytes = Math.min(MAX_OUTPUT_BYTES, Math.max(1_024, Math.floor(rawOutput)));
    return { command, projectRoot, cwd, approved: request.approved === true, timeoutMs, maxOutputBytes, env: request.env };
  }

  private realDirectory(value: string, label: string): string {
    const resolved = path.resolve(value);
    let real: string;
    try { real = fs.realpathSync(resolved); } catch { throw new Error(`${label} does not exist: ${value}`); }
    if (!fs.statSync(real).isDirectory()) throw new Error(`${label} is not a directory: ${value}`);
    return real;
  }

  private buildEnvironment(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const allow = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'TERM', 'SHELL', 'ComSpec', 'SystemRoot', 'PATHEXT', 'WINDIR', 'NODE_ENV']);
    const env: NodeJS.ProcessEnv = {};
    for (const key of allow) if (process.env[key] !== undefined) env[key] = process.env[key];
    for (const [key, value] of Object.entries(overrides ?? {})) if (allow.has(key) && value !== undefined) env[key] = value;
    env.AMD_SANDBOX = '1';
    // Keep deterministic behavior for shells that inspect a home directory.
    env.HOME ||= os.homedir();
    return env;
  }
}
