import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolTrustStore } from '../../src/core/security/ToolTrustStore';
import type { ApprovalMode } from '../../src/core/security/ApprovalPolicy';
import type { MainContext } from '../../src/main/MainContext';
import { approveToolCall } from '../../src/main/approvalPrompt';

const native = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock('electron', () => ({ dialog: native }));
const directories: string[] = [];
afterEach(() => { native.showMessageBox.mockReset(); for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(mode: ApprovalMode = 'full') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-tool-trust-approval-'));
  directories.push(root);
  const toolTrust = new ToolTrustStore(path.join(root, 'tool-trust.json'));
  const context = { toolTrust, preferences: { approvalMode: mode }, getWindow: () => null } as unknown as MainContext;
  return { context, toolTrust };
}

describe('native tool trust decisions', () => {
  it('denies a disabled read tool before consulting the current permission mode', async () => {
    const value = fixture(); value.toolTrust.set('read', 'disabled');
    expect(await approveToolCall(value.context, { toolName: 'read', input: { path: 'README.md' } })).toBe('工具已在信任设置中禁用：read');
    expect(native.showMessageBox).not.toHaveBeenCalled();
  });
  it.each(['ask', 'auto', 'full'] as const)('asks for a read tool explicitly configured for confirmation in %s mode', async (mode) => {
    const value = fixture(mode); value.toolTrust.set('read', 'ask'); native.showMessageBox.mockResolvedValue({ response: 1 });
    expect(await approveToolCall(value.context, { toolName: 'read', input: { path: 'README.md' } })).toBeUndefined();
    expect(native.showMessageBox).toHaveBeenCalledOnce();
    expect(native.showMessageBox.mock.calls[0][0].detail).toContain('工具信任设置要求逐次确认');
  });
  it('permits an explicitly automatic MCP tool in the ask permission mode', async () => {
    const value = fixture('ask'); value.toolTrust.set('mcp__docs__search', 'auto');
    expect(await approveToolCall(value.context, { toolName: 'mcp__docs__search', input: { query: 'project conventions' } })).toBeUndefined();
    expect(native.showMessageBox).not.toHaveBeenCalled();
  });
  it('continues the existing safe-tool and mutation decisions when no trust choice is set', async () => {
    const value = fixture('ask');
    expect(await approveToolCall(value.context, { toolName: 'read', input: { path: 'README.md' } })).toBeUndefined();
    native.showMessageBox.mockResolvedValue({ response: 0 });
    expect(await approveToolCall(value.context, { toolName: 'write', input: { path: 'src/demo.ts', content: 'export const demo = 1;' } })).toBe('用户拒绝了这次工具调用');
    expect(native.showMessageBox).toHaveBeenCalledOnce();
  });
});
