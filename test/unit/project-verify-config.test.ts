import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmProjectVerifyConfig, defaultVerifyConfig, isVerifyConfigCurrent, loadProjectVerifyConfig, projectVerifyConfigPath, validateProjectVerifyDraft } from '@core/verify/ProjectVerifyConfig';
import { resolveVerifyCommands } from '@core/verify/VerifyCommandResolver';

let directory: string;
let root: string;
let dataDir: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-verify-config-'));
  root = path.join(directory, 'project'); dataDir = path.join(directory, 'data');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'example lint' } }));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('confirmed project verification configuration', () => {
  it('persists user overrides under the canonical root hash with confirmation metadata', async () => {
    const resolved = await resolveVerifyCommands(root);
    const draft = { ...defaultVerifyConfig(resolved.commands), mode: 'full' as const, timeoutMs: 30_000, maxRepairRounds: 3, commands: [{ id: 'custom', label: 'Custom check', command: 'npm run verify', phase: 'quick' as const }] };
    const saved = confirmProjectVerifyConfig(dataDir, root, draft, resolved.fingerprint, new Date('2026-11-09T00:00:00Z'));
    expect(saved).toMatchObject({ ...draft, confirmedAt: '2026-11-09T00:00:00.000Z', manifestFingerprint: resolved.fingerprint });
    expect(loadProjectVerifyConfig(dataDir, root, resolved.fingerprint)).toEqual(saved);
    expect(path.relative(dataDir, projectVerifyConfigPath(dataDir, root)).split(path.sep).join('/')).toMatch(/^projects\/[a-f0-9]{40}\/verify\.json$/);
  });

  it('requires confirmation again when the source manifest fingerprint changes', async () => {
    const initial = await resolveVerifyCommands(root);
    const saved = confirmProjectVerifyConfig(dataDir, root, defaultVerifyConfig(initial.commands), initial.fingerprint);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'example lint updated' } }));
    const changed = await resolveVerifyCommands(root);
    expect(isVerifyConfigCurrent(saved, changed.fingerprint)).toBe(false);
    expect(loadProjectVerifyConfig(dataDir, root, changed.fingerprint)).toBeUndefined();
    expect(loadProjectVerifyConfig(dataDir, root)).toEqual(saved);
  });

  it('returns no confirmed configuration for missing or malformed persistence', () => {
    expect(loadProjectVerifyConfig(dataDir, root)).toBeUndefined();
    const file = projectVerifyConfigPath(dataDir, root);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}');
    expect(loadProjectVerifyConfig(dataDir, root)).toBeUndefined();
  });

  it('validates repair limits, command identity and timeouts', () => {
    const draft = defaultVerifyConfig([{ id: 'lint', label: 'lint', command: 'npm run lint', phase: 'quick' }]);
    expect(draft).toMatchObject({ mode: 'quick', timeoutMs: 120_000, maxRepairRounds: 2 });
    expect(() => validateProjectVerifyDraft({ ...draft, maxRepairRounds: 4 })).toThrow('0–3');
    expect(() => validateProjectVerifyDraft({ ...draft, timeoutMs: 0 })).toThrow('1000–120000');
    expect(() => validateProjectVerifyDraft({ ...draft, commands: [...draft.commands, ...draft.commands] })).toThrow('重复');
    expect(() => validateProjectVerifyDraft({ ...draft, commands: [{ ...draft.commands[0], command: ' ' }] })).toThrow('内容无效');
  });

  it('retains the previous confirmation if atomic replacement fails', async () => {
    const resolved = await resolveVerifyCommands(root);
    const draft = defaultVerifyConfig(resolved.commands);
    const saved = confirmProjectVerifyConfig(dataDir, root, draft, resolved.fingerprint);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('ordinary disk failure'); });
    expect(() => confirmProjectVerifyConfig(dataDir, root, { ...draft, mode: 'full' }, resolved.fingerprint)).toThrow('ordinary disk failure');
    expect(loadProjectVerifyConfig(dataDir, root)).toEqual(saved);
    expect(fs.readdirSync(path.dirname(projectVerifyConfigPath(dataDir, root)))).toEqual(['verify.json']);
  });
});
