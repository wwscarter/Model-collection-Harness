import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { CommandExecutor } from '../../src/core/tty/CommandExecutor';

describe('CommandExecutor', () => {
  let executor: CommandExecutor | undefined;
  let root: string | undefined;

  afterEach(() => {
    executor?.dispose();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('requires explicit approval and keeps execution inside the project root', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-sandbox-'));
    executor = new CommandExecutor();
    await expect(executor.run({ command: 'echo blocked', projectRoot: root })).rejects.toThrow('explicit approval');
    await expect(executor.run({ command: 'pwd', projectRoot: root, cwd: '..', approved: true })).rejects.toThrow('inside the project root');
  });

  it('runs an approved command with a filtered environment and captures output', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-sandbox-'));
    executor = new CommandExecutor();
    const result = await executor.run({ command: `${process.execPath} -e "process.stdout.write(process.cwd() + ':' + process.env.AMD_SANDBOX);"`, projectRoot: root, approved: true });
    expect(result.exitCode).toBe(0);
    const canonicalRoot = fs.realpathSync(root);
    expect(result.output).toContain(`${canonicalRoot}:${result.sandbox.enabled ? '1' : '0'}`);
    expect(result.cwd).toBe(canonicalRoot);
  });

  it('caps output and marks the result as truncated', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-sandbox-'));
    executor = new CommandExecutor();
    const result = await executor.run({ command: `${process.execPath} -e "process.stdout.write('x'.repeat(10000));"`, projectRoot: root, approved: true, maxOutputBytes: 1024 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024);
  });

  it('preserves split UTF-8 characters and interleaved output order', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-command-output-'));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: () => true }) as unknown as ChildProcess;
    executor = new CommandExecutor({ spawn: () => child });
    const pending = executor.run({ command: 'build project', projectRoot: root, approved: true });
    const bytes = Buffer.from('中文');
    stdout.write(bytes.subarray(0, 1));
    stdout.write(bytes.subarray(1));
    stderr.write('警告');
    stdout.write('完成');
    child.emit('close', 0);
    const result = await pending;
    expect(result.stdout).toBe('中文完成');
    expect(result.stderr).toBe('警告');
    expect(result.output).toBe('中文警告完成');
  });

  it('keeps a multibyte output cutoff within the byte budget', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-command-output-'));
    executor = new CommandExecutor();
    const result = await executor.run({ command: `${process.execPath} -e "process.stdout.write('中'.repeat(1000));"`, projectRoot: root, approved: true, maxOutputBytes: 1024 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024);
    expect(result.output).not.toContain('�');
  });

  it('supports cancellation of a running process', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-sandbox-'));
    executor = new CommandExecutor();
    const handle = executor.start({ command: `${process.execPath} -e "setTimeout(() => {}, 10000);"`, projectRoot: root, approved: true });
    expect(executor.cancel(handle.id)).toBe(true);
    const result = await handle.promise;
    expect(result.cancelled).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('terminates the whole process group and settles after cancellation', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-sandbox-'));
    executor = new CommandExecutor();
    const script = path.join(root, 'spawn-child.cjs');
    fs.writeFileSync(script, `const { spawn } = require('node:child_process');\nconst child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nprocess.stdout.write(String(child.pid));\nsetInterval(() => {}, 1000);\n`);
    const handle = executor.start({ command: `${process.execPath} ${JSON.stringify(script)}`, projectRoot: root, approved: true });
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('grandchild pid was not reported')), 5_000);
      const unsubscribe = executor!.onData(handle.id, (event) => {
        const match = event.data.match(/^\d+$/);
        if (!match) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(Number(event.data));
      });
    });
    expect(executor.cancel(handle.id)).toBe(true);
    const result = await Promise.race([
      handle.promise,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('cancellation did not settle')), 4_000)),
    ]);
    expect(result.cancelled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  }, 10_000);
});
