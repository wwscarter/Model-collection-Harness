import { dialog, shell } from 'electron';
import fs from 'node:fs/promises';
import type { MainContext } from '../MainContext';
import { handle } from './register';

export function register(ctx: MainContext): void {
  const asset = async (id: unknown) => {
    if (!ctx.media || typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('媒体资产无效');
    return ctx.media.readAsset(id);
  };
  handle('media:open', async (_event, id: unknown) => {
    await asset(id);
    const error = await shell.openPath(ctx.media!.getAssetPath(id as string));
    if (error) throw new Error(error);
  });
  handle('media:export', async (_event, id: unknown) => {
    const { artifact, bytes } = await asset(id);
    const options = { title: '保存生成素材', defaultPath: artifact.fileName };
    const window = ctx.getWindow();
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { cancelled: true };
    await fs.writeFile(result.filePath, bytes);
    return { cancelled: false, path: result.filePath };
  });
}
