import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateCommandApproval, evaluateToolApproval, loadApprovalMode, savePreferences, type ApprovalMode } from '@core/security/ApprovalPolicy';

const modes: ApprovalMode[] = ['ask', 'auto', 'full'];
const directories: string[] = [];
const temporaryPreferences = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-approval-'));
  directories.push(directory);
  return path.join(directory, 'preferences.json');
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('approval decisions', () => {
  it.each(modes)('allows existing safe tools in %s mode', (mode) => {
    for (const toolName of ['read', 'ls', 'grep', 'find', 'code_symbols', 'code_search', 'web_search', 'web_fetch', 'process_status', 'process_list', 'remember', 'recall']) {
      expect(evaluateToolApproval(mode, { toolName, input: {} }).decision).toBe('allow');
    }
  });

  it.each(modes)('preserves mutation and external-tool decisions in %s mode', (mode) => {
    for (const toolName of ['write', 'edit', 'stop_process', 'mcp_example']) {
      expect(evaluateToolApproval(mode, { toolName, input: { path: 'src/example.ts' } }).decision).toBe(mode === 'ask' ? 'confirm' : 'allow');
    }
  });

  it.each(modes)('uses the same ordinary command decision for IPC and tools in %s mode', (mode) => {
    const command = 'npm test';
    expect(evaluateCommandApproval(mode, command).decision).toBe(mode === 'ask' ? 'confirm' : 'allow');
    expect(evaluateToolApproval(mode, { toolName: 'run_command', input: { command } })).toEqual(evaluateCommandApproval(mode, command));
  });

  it('retains native confirmation for an administrative command in auto mode', () => {
    expect(evaluateCommandApproval('auto', 'sudo --version').decision).toBe('confirm');
    expect(evaluateToolApproval('auto', { toolName: 'run_command', input: { command: 'sudo --version' } }).decision).toBe('confirm');
    expect(evaluateCommandApproval('full', 'sudo --version').decision).toBe('allow');
  });
});

describe('approval preferences', () => {
  it('defaults missing, malformed and unknown settings to ask', () => {
    const file = temporaryPreferences();
    expect(loadApprovalMode(file)).toBe('ask');
    for (const content of ['invalid json', '{}', '{"approvalMode":"unknown"}', '{"approvalMode":true}']) {
      fs.writeFileSync(file, content);
      expect(loadApprovalMode(file)).toBe('ask');
    }
  });

  it.each(modes)('persists and reloads %s mode', (mode) => {
    const file = path.join(path.dirname(temporaryPreferences()), 'nested', 'preferences.json');
    savePreferences(file, mode);
    expect(loadApprovalMode(file)).toBe(mode);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ approvalMode: mode });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['preferences.json']);
  });

  it('retains persisted preferences and removes the temporary file if replacement fails', () => {
    const file = temporaryPreferences();
    savePreferences(file, 'auto');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => savePreferences(file, 'ask')).toThrow('设置保存失败：disk full');
    expect(loadApprovalMode(file)).toBe('auto');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['preferences.json']);
  });
});
