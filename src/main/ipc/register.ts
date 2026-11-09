import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { isAppUrl } from '../security/windowHardening';

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isAppUrl(event.senderFrame?.url ?? '')) throw new Error('不受信任的调用来源，已拒绝本次 IPC 请求');
}

/** Register every handler behind the same sender check. */
export function handle<T extends unknown[]>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: T) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return listener(event, ...(args as T));
  });
}

