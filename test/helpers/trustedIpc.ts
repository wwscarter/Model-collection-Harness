import { trustAppWindow } from '../../src/main/security/windowHardening';

export function trustedIpcEvent() {
  const entry = new URL('file:///newai/dist/renderer/index.html');
  const senderFrame = { url: entry.href };
  const sender = { mainFrame: senderFrame };
  trustAppWindow(sender as Electron.WebContents, entry);
  return { sender, senderFrame };
}
