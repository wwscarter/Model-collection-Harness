import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveVerifyCommands } from '@core/verify/VerifyCommandResolver';

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-verify-resolver-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const file = (name: string, content: string) => fs.writeFileSync(path.join(root, name), content);

describe('verification command inference', () => {
  it.each([['package-lock.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn']])('uses %s to infer %s scripts', async (lock, manager) => {
    file('package.json', JSON.stringify({ scripts: { lint: 'example lint', typecheck: 'example types', test: 'example tests', build: 'example build' } }));
    file(lock, 'ordinary fixture lock');
    const resolved = await resolveVerifyCommands(root);
    expect(resolved.commands.map((command) => [command.command, command.phase])).toEqual([
      [manager + ' run lint', 'quick'], [manager + ' run typecheck', 'quick'], [manager + ' run test', 'full'], [manager + ' run build', 'full'],
    ]);
    expect(resolved.projectRoot).toBe(root);
    expect(resolved.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not invent commands for empty scripts or a TypeScript configuration alone', async () => {
    file('package.json', JSON.stringify({ scripts: { lint: '  ', typecheck: 1, test: null } }));
    file('tsconfig.json', '{}');
    expect((await resolveVerifyCommands(root)).commands).toEqual([]);
  });

  it('uses a configured build as a quick fallback and recognizes an explicit type-check script', async () => {
    file('package.json', JSON.stringify({ scripts: { build: 'example build' } }));
    expect((await resolveVerifyCommands(root)).commands).toEqual([{ id: 'node:build', label: 'build', command: 'npm run build', phase: 'quick' }]);
    file('package.json', JSON.stringify({ scripts: { 'type-check': 'example types', build: 'example build' } }));
    expect((await resolveVerifyCommands(root)).commands.map((command) => [command.command, command.phase])).toEqual([['npm run type-check', 'quick'], ['npm run build', 'full']]);
  });

  it.each([
    ['Cargo.toml', '[package]\nname = "ordinary-fixture"\nversion = "0.0.0"', ['cargo check', 'cargo test']],
    ['go.mod', 'module example.com/ordinary-fixture\ngo 1.22', ['go vet ./...', 'go test ./...']],
    ['pyproject.toml', '[tool.pytest.ini_options]\ntestpaths = ["tests"]', ['pytest -q']],
    ['requirements.txt', 'pytest', ['pytest -q']],
    ['pom.xml', '<project><artifactId>ordinary-fixture</artifactId></project>', ['mvn -q test']],
  ])('infers ordinary checks from %s', async (manifest, content, commands) => {
    file(manifest, content);
    expect((await resolveVerifyCommands(root)).commands.map((command) => command.command)).toEqual(commands);
  });

  it('returns an empty result for projects without supported manifests', async () => {
    file('README.md', 'Ordinary documentation project');
    expect((await resolveVerifyCommands(root)).commands).toEqual([]);
  });

  it('reports malformed package metadata without proposing guessed scripts', async () => {
    file('package.json', 'ordinary invalid JSON');
    const result = await resolveVerifyCommands(root);
    expect(result.commands).toEqual([]);
    expect(result.diagnostics).toEqual([expect.stringContaining('有效 JSON')]);
  });

  it('fingerprints script bodies and lockfile contents and stays stable for unchanged inputs', async () => {
    file('package.json', JSON.stringify({ scripts: { test: 'example tests' } }));
    const first = await resolveVerifyCommands(root);
    expect((await resolveVerifyCommands(root)).fingerprint).toBe(first.fingerprint);
    file('package.json', JSON.stringify({ scripts: { test: 'example updated tests' } }));
    const changed = await resolveVerifyCommands(root);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    file('package-lock.json', '{"lockfileVersion":3}');
    expect((await resolveVerifyCommands(root)).fingerprint).not.toBe(changed.fingerprint);
  });

  it('honors cancellation before inspecting the project', async () => {
    const controller = new AbortController(); controller.abort(new Error('ordinary cancellation'));
    await expect(resolveVerifyCommands(root, { signal: controller.signal })).rejects.toThrow('ordinary cancellation');
  });
});
