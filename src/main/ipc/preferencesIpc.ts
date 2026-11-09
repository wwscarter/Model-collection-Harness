import { savePreferences } from '@core/security/ApprovalPolicy';
import type { MainContext } from '../MainContext';
import { handle } from './register';

export function register(ctx: MainContext): void {
  handle('preferences:get', () => ({ approvalMode: ctx.preferences.approvalMode }));
  handle('preferences:set', (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('设置无效');
    const value = input as { approvalMode?: unknown };
    if (value.approvalMode !== 'ask' && value.approvalMode !== 'auto' && value.approvalMode !== 'full') throw new Error('权限模式无效');
    savePreferences(ctx.preferencesPath, value.approvalMode);
    ctx.preferences.approvalMode = value.approvalMode;
    return { approvalMode: ctx.preferences.approvalMode };
  });
}
