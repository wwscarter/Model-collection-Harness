import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustStore } from '@core/security/TrustStore';

let directory: string;
let root: string;
let file: string;
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-trust-')));
  root = path.join(directory, 'project'); fs.mkdirSync(root);
  file = path.join(directory, 'data', 'trust.json');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('explicit project file-content trust', () => {
  it('requires an explicit grant and persists its canonical project, relative file and hash', () => {
    const store = new TrustStore(file);
    const sha256 = hash('Prefer concise explanations.');
    expect(store.isTrusted(root, 'AGENTS.md', sha256)).toBe(false);
    const granted = store.grant({ projectRoot: root, file: path.join(root, 'AGENTS.md'), sha256 }, new Date('2026-11-09T00:00:00Z'));
    expect(granted).toEqual({ projectRoot: root, file: 'AGENTS.md', sha256, grantedAt: '2026-11-09T00:00:00.000Z' });
    expect(new TrustStore(file).isTrusted(root, 'AGENTS.md', sha256)).toBe(true);
    expect(store.list(root)).toEqual([granted]);
  });

  it('requires confirmation for changed ordinary text and replaces the prior grant', () => {
    const store = new TrustStore(file);
    const first = hash('Use descriptive variable names.');
    const second = hash('Use descriptive variable names and short examples.');
    store.grant({ projectRoot: root, file: '.newai/rules/style.md', sha256: first });
    expect(store.isTrusted(root, '.newai/rules/style.md', second)).toBe(false);
    store.grant({ projectRoot: root, file: '.newai/rules/style.md', sha256: second });
    expect(store.list()).toHaveLength(1);
    expect(store.isTrusted(root, '.newai/rules/style.md', first)).toBe(false);
    expect(store.isTrusted(root, '.newai/rules/style.md', second)).toBe(true);
  });

  it('revokes a file grant and leaves other ordinary grants unchanged', () => {
    const store = new TrustStore(file);
    const sha256 = hash('Ordinary rule text.');
    store.grant({ projectRoot: root, file: 'AGENTS.md', sha256 });
    store.grant({ projectRoot: root, file: '.newai/hooks.json', sha256 });
    expect(store.revoke(root, 'AGENTS.md')).toBe(true);
    expect(store.revoke(root, 'AGENTS.md')).toBe(false);
    expect(new TrustStore(file).list(root).map((grant) => grant.file)).toEqual(['.newai/hooks.json']);
  });

  it('preserves both disk and live trust state when atomic replacement fails', () => {
    const store = new TrustStore(file);
    const first = hash('Ordinary original rule.'); const second = hash('Ordinary revised rule.');
    store.grant({ projectRoot: root, file: 'AGENTS.md', sha256: first });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('ordinary disk failure'); });
    expect(() => store.grant({ projectRoot: root, file: 'AGENTS.md', sha256: second })).toThrow('ordinary disk failure');
    expect(store.isTrusted(root, 'AGENTS.md', first)).toBe(true);
    expect(new TrustStore(file).isTrusted(root, 'AGENTS.md', first)).toBe(true);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['trust.json']);
  });

  it('keeps malformed persistence untrusted and reports a diagnostic', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'ordinary invalid JSON');
    const store = new TrustStore(file);
    expect(store.list()).toEqual([]);
    expect(store.diagnostics).toEqual([expect.stringContaining('重新确认')]);
  });
});
