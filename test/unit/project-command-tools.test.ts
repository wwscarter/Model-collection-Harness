import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectCommandTools } from '../../src/core/tools/projectCommandTools';
import { ProjectProcessManager, type ProjectProcessSnapshot } from '../../src/core/tty/ProjectProcessManager';

let manager: ProjectProcessManager;
let projectRoot: string;
const quote = (value: string) => process.platform === 'win32' ? `"${value.replaceAll('"', '""')}"` : String.fromCharCode(39) + value.replaceAll(String.fromCharCode(39), String.fromCharCode(39, 34, 39, 34, 39)) + String.fromCharCode(39);
const node = (source: string) => `${quote(process.execPath)} -e ${quote(source)}`;

async function call(name: string, params: Record<string, unknown>, signal?: AbortSignal) {
  const tool = createProjectCommandTools(projectRoot, manager).find((tool) => tool.name === name)!;
  return tool.execute('call-test', params, signal, undefined, {} as never);
}

function writeServer(name = 'server.cjs'): string {
  const file = path.join(projectRoot, name);
  fs.writeFileSync(file, `
    const http = require('node:http');
    const server = http.createServer((_req, res) => res.end('newAi server: ' + process.cwd()));
    server.listen(0, '127.0.0.1', () => console.log('READY http://127.0.0.1:' + server.address().port + '/'));
  `);
  return `${quote(process.execPath)} ${quote(file)}`;
}

async function waitForReadyServer(snapshot: ProjectProcessSnapshot): Promise<ProjectProcessSnapshot> {
  // Startup observation is a time window, not a readiness guarantee. A loaded
  // machine can need longer to start the wrapper and its HTTP child.
  await vi.waitFor(() => {
    const current = manager.status(snapshot.processId);
    expect(current.running).toBe(true);
    expect(current.urls).toHaveLength(1);
  }, { timeout: 5_000, interval: 25 });
  return manager.status(snapshot.processId);
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-project-command-'));
  manager = new ProjectProcessManager();
});

afterEach(async () => {
  await Promise.allSettled(manager.list().filter((process) => process.running).map((process) => manager.stop(process.processId)));
  manager.dispose();
  fs.rmSync(projectRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('project command tools', () => {
  it.skipIf(process.platform !== 'darwin')('adds common development tool locations to a Finder-style PATH', async () => {
    vi.stubEnv('PATH', '/usr/bin:/bin');
    const result = await manager.run({ projectRoot, command: node('console.log(process.env.PATH)') });
    expect(result.exitCode).toBe(0);
    const directories = result.output.trim().split(path.delimiter);
    expect(directories.slice(0, 2)).toEqual(['/usr/bin', '/bin']);
    expect(directories).toContain('/opt/homebrew/bin');
    expect(directories).toContain('/usr/local/bin');
    expect(new Set(directories).size).toBe(directories.length);
  });

  it('runs ordinary commands in the selected project and reports nonzero exits', async () => {
    const successful = await call('run_command', { command: node('console.log(process.cwd())') });
    expect(successful.isError).toBe(false);
    expect(successful.details).toMatchObject({ cwd: fs.realpathSync(projectRoot), status: 'completed', exitCode: 0, background: false, running: false });
    expect((successful.details as ProjectProcessSnapshot).output.trim()).toBe(fs.realpathSync(projectRoot));
    const failed = await call('run_command', { command: node("console.error('build failed'); process.exit(7)") });
    expect(failed.isError).toBe(true);
    expect(failed.details).toMatchObject({ status: 'failed', exitCode: 7, stderr: 'build failed\n' });
    expect(failed.content[0]).toMatchObject({ text: expect.stringContaining('退出码：7') });
  });

  it('keeps a real HTTP server across tool instances, then queries and stops it', async () => {
    const turn = new AbortController();
    const started = await call('run_command', { command: writeServer(), background: true, timeoutMs: 500 }, turn.signal);
    const process = await waitForReadyServer(started.details as ProjectProcessSnapshot);
    expect(started.isError).toBe(false);
    expect(process).toMatchObject({ status: 'running', running: true, background: true, cwd: fs.realpathSync(projectRoot) });
    expect(process.pid).toBeGreaterThan(0);
    expect(process.urls).toHaveLength(1);
    turn.abort(); // A completed agent turn no longer owns a returned server.
    expect(await (await fetch(process.urls[0])).text()).toBe(`newAi server: ${fs.realpathSync(projectRoot)}`);
    const queried = await call('process_status', { processId: process.processId });
    expect(queried.details).toMatchObject({ processId: process.processId, running: true, output: expect.stringContaining('READY') });
    const stopped = await call('stop_process', { processId: process.processId });
    expect(stopped.details).toMatchObject({ status: 'stopped', running: false });
    expect(stopped.isError).toBe(false);
    await expect(fetch(process.urls[0])).rejects.toThrow();
  });

  it.each([false, true])('cancels an active command, background=%s', async (background) => {
    const controller = new AbortController();
    const pending = call('run_command', { command: node('setInterval(() => {}, 1000)'), background, timeoutMs: 2000 }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ running: false, status: 'stopped', cancelled: true, timedOut: false });
  });

  it('ends foreground commands at their deadline and marks the timeout', async () => {
    const result = await call('run_command', { command: node('setInterval(() => {}, 1000)'), timeoutMs: 100 });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ running: false, status: 'failed', timedOut: true, cancelled: false });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('超时') });
  });

  it.each([0, 3])('does not report a background startup that exited as a running server (exit %s)', async (exitCode) => {
    const result = await call('run_command', { command: node(`process.exit(${exitCode})`), background: true, timeoutMs: 500 });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ running: false, status: 'failed', exitCode });
  });

  it('keeps bounded recent logs without stopping a noisy background service', async () => {
    const result = await call('run_command', { command: node("process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)"), background: true, timeoutMs: 500 });
    const process = result.details as ProjectProcessSnapshot;
    expect(process).toMatchObject({ running: true, truncated: true });
    expect(Buffer.byteLength(process.output)).toBeLessThanOrEqual(64 * 1024);
    expect(process.output).toContain('x'.repeat(100));
  });

  it('stops the child web server of a shell command, including inherited output pipes', async () => {
    writeServer();
    const wrapper = path.join(projectRoot, 'wrapper.cjs');
    fs.writeFileSync(wrapper, `require('node:child_process').spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(path.join(projectRoot, 'server.cjs'))}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`);
    const result = await call('run_command', { command: `${quote(process.execPath)} ${quote(wrapper)}`, background: true, timeoutMs: 500 });
    const serverInfo = await waitForReadyServer(result.details as ProjectProcessSnapshot);
    expect(serverInfo.urls).toHaveLength(1);
    expect((await fetch(serverInfo.urls[0])).ok).toBe(true);
    await manager.stop(serverInfo.processId);
    await expect(fetch(serverInfo.urls[0])).rejects.toThrow();
  });

  it('terminates managed web servers when the app disposes the manager', async () => {
    const process = await waitForReadyServer(await manager.run({ projectRoot, command: writeServer(), background: true, timeoutMs: 500 }));
    expect((await fetch(process.urls[0])).ok).toBe(true);
    manager.dispose();
    await vi.waitFor(() => expect(manager.status(process.processId).running).toBe(false));
    await expect(fetch(process.urls[0])).rejects.toThrow();
    await expect(manager.run({ projectRoot, command: node('console.log(1)') })).rejects.toThrow('已关闭');
  });
});
