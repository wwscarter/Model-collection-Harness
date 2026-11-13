import { session, type WebContents } from 'electron';

let appEntry: URL | undefined;
let appContents: WebContents | undefined;

export function trustAppWindow(contents: WebContents, entry: URL): void {
  appContents = contents;
  appEntry = entry;
}

export function isAppUrl(raw: string): boolean {
  if (!appEntry) return false;
  try {
    const url = new URL(raw);
    if (appEntry.protocol !== 'file:') return url.origin === appEntry.origin;
    url.hash = '';
    return url.href === appEntry.href;
  } catch { return false; }
}

export function isAppSender(event: Electron.IpcMainInvokeEvent): boolean {
  return Boolean(appContents && event.sender === appContents && event.senderFrame
    && event.senderFrame === appContents.mainFrame && isAppUrl(event.senderFrame.url));
}

export function installSessionHardening(): void {
  // Only the clipboard write used by the copy buttons is allowed. Camera,
  // microphone, notifications, geolocation and USB stay denied by default.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
}

/** Applies to every WebContents, including ones created before our window listeners. */
export function hardenWebContents(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

