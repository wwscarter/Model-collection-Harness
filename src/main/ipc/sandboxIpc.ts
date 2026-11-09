import fs from 'node:fs/promises';
import { dialog, type OpenDialogOptions } from 'electron';
import { getSandboxStatus } from '@core/security/Sandbox';
import { saveSandboxSettings, validateSandboxSettings } from '@core/security/SandboxSettings';
import type { MainContext } from '../MainContext';
import { handle } from './register';

export function register(ctx: MainContext): void {
  const configuration = () => ({ settings: ctx.commandSandbox.settings, status: getSandboxStatus() });
  handle('sandbox:get', configuration);
  handle('sandbox:set', (_event, input: unknown) => {
    const settings = validateSandboxSettings(input);
    ctx.commandSandbox.settings = saveSandboxSettings(ctx.sandboxSettingsPath, settings);
    return configuration();
  });
  handle('sandbox:pick-directory', async () => {
    const options: OpenDialogOptions = { title: '选择允许命令写入的文件夹', properties: ['openDirectory'] };
    const window = ctx.getWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return undefined;
    const root = await fs.realpath(result.filePaths[0]);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('请选择已存在的文件夹');
    return root;
  });
}
