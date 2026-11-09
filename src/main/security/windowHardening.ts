import { session } from 'electron';

const APP_INDEX_SUFFIX = '/renderer/index.html';

/** Only newAi's own page may send IPC. A navigated or injected page must not reach main. */
export function isAppUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) return url.origin === new URL(devUrl).origin;
    return url.protocol === 'file:' && url.pathname.endsWith(APP_INDEX_SUFFIX);
  } catch {
    return false;
  }
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

