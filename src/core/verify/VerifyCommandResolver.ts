import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ResolvedVerifyCommands, VerifyCommand } from './VerificationTypes';

const SOURCES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini', 'pom.xml'];

/** Manifest bytes, including lockfiles, are hashed before any confirmed command is reused. */
export async function resolveVerifyCommands(projectRoot: string, options: { signal?: AbortSignal } = {}): Promise<ResolvedVerifyCommands> {
  options.signal?.throwIfAborted();
  const root = await fs.promises.realpath(projectRoot);
  if (!(await fs.promises.stat(root)).isDirectory()) throw new Error('验证项目目录无效');
  const hash = createHash('sha256');
  const present = new Set<string>();
  const diagnostics: string[] = [];
  let packageText: string | undefined;
  for (const name of SOURCES) {
    options.signal?.throwIfAborted();
    hash.update(name + '\0');
    const filePath = path.join(root, name);
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile()) { hash.update('not-regular\0'); diagnostics.push(name + ' 不是普通文件，未用于推断检查命令'); continue; }
      present.add(name);
      const bytes: Buffer[] = [];
      for await (const part of fs.createReadStream(filePath, { signal: options.signal })) {
        const chunk = Buffer.from(part);
        hash.update(chunk);
        if (name === 'package.json' && stat.size <= 1024 * 1024) bytes.push(chunk);
      }
      if (name === 'package.json') {
        if (stat.size > 1024 * 1024) diagnostics.push('package.json 超过 1MB，未推断其中的脚本');
        else packageText = Buffer.concat(bytes).toString('utf8');
      }
      hash.update('\0');
    } catch (error) {
      options.signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      hash.update('missing-or-unreadable:' + code + '\0');
      if (code !== 'ENOENT') diagnostics.push(name + ' 无法读取，未用于推断检查命令');
      present.delete(name);
    }
  }
  const commands: VerifyCommand[] = [];
  const add = (id: string, label: string, command: string, phase: VerifyCommand['phase']) => commands.push({ id, label, command, phase });
  if (packageText !== undefined) {
    try {
      const manifest = JSON.parse(packageText) as { scripts?: Record<string, unknown>; packageManager?: unknown } | null;
      const scripts = manifest?.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts) ? manifest.scripts : {};
      const manager = present.has('pnpm-lock.yaml') ? 'pnpm' : present.has('yarn.lock') ? 'yarn' : 'npm';
      const has = (name: string) => typeof scripts[name] === 'string' && Boolean((scripts[name] as string).trim());
      const typecheck = ['typecheck', 'type-check', 'check:types'].find(has);
      if (has('lint')) add('node:lint', 'lint', manager + ' run lint', 'quick');
      if (typecheck) add('node:typecheck', 'typecheck', manager + ' run ' + typecheck, 'quick');
      if (has('test')) add('node:test', 'test', manager + ' run test', 'full');
      if (has('build')) add('node:build', 'build', manager + ' run build', has('lint') || typecheck ? 'full' : 'quick');
    } catch { diagnostics.push('package.json 不是有效 JSON，未推断其中的脚本'); }
  }
  if (present.has('Cargo.toml')) { add('rust:check', 'cargo check', 'cargo check', 'quick'); add('rust:test', 'cargo test', 'cargo test', 'full'); }
  if (present.has('go.mod')) { add('go:vet', 'go vet', 'go vet ./...', 'quick'); add('go:test', 'go test', 'go test ./...', 'full'); }
  if (['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini'].some((name) => present.has(name))) add('python:test', 'pytest', 'pytest -q', 'full');
  if (present.has('pom.xml')) add('java:test', 'maven test', 'mvn -q test', 'full');
  options.signal?.throwIfAborted();
  return { projectRoot: root, fingerprint: hash.digest('hex'), commands, diagnostics };
}
