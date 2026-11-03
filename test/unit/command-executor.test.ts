import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    expect(result.output).toContain(`${canonicalRoot}:1`);
    expect(result.cwd).toBe(canonicalRoot);
  });

  it('caps output and marks the result as truncated', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-sandbox-'));
    executor = new CommandExecutor();
    const result = await executor.run({ command: `${process.execPath} -e "process.stdout.write('x'.repeat(10000));"`, projectRoot: root, approved: true, maxOutputBytes: 1024 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024);
  });

  it('supports cancellation of a running process', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-sandbox-'));
    executor = new CommandExecutor();
    const handle = executor.start({ command: `${process.execPath} -e "setTimeout(() => {}, 10000);"`, projectRoot: root, approved: true });
    expect(executor.cancel(handle.id)).toBe(true);
    const result = await handle.promise;
    expect(result.cancelled).toBe(true);
  });
});
