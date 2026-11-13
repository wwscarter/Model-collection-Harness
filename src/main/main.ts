import { app, BrowserWindow, nativeTheme, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MainContext } from './MainContext';
import { createMainContext, disposeMainContext, reportStartupFailure, showCredentialWarning } from './bootstrap';
import { registerHandlers } from './ipc';
import { hardenWebContents, installSessionHardening, trustAppWindow } from './security/windowHardening';
import { registerMediaProtocol } from './mediaProtocol';

protocol.registerSchemesAsPrivileged([{ scheme: 'newai-media', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function startApplication(): void {
  const state: { window: BrowserWindow | null; context?: MainContext } = { window: null };
  function createWindow(): void {
    state.window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1000,
      minHeight: 680,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0A0A0A' : '#FFFFFF',
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 21 } } : {}),
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
      }
    });
    const updateTheme = () => { state.window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0A0A0A' : '#FFFFFF'); };
    nativeTheme.on('updated', updateTheme);
    const indexPath = path.join(__dirname, '../renderer/index.html');
    const devUrl = process.env.NODE_ENV === 'development' && !app.isPackaged && process.env.ELECTRON_RENDERER_URL;
    const entry = devUrl ? new URL(devUrl) : pathToFileURL(indexPath);
    trustAppWindow(state.window.webContents, entry);
    if (devUrl) void state.window.loadURL(entry.href);
    else void state.window.loadFile(indexPath);
    state.window.on('closed', () => { nativeTheme.removeListener('updated', updateTheme); state.window = null; });
  }

  async function bootstrap(): Promise<void> {
    await app.whenReady();
    const ctx = await createMainContext(app.getPath('userData'), () => state.window);
    state.context = ctx;
    if (ctx.media) registerMediaProtocol(ctx.media);
    installSessionHardening();
    app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));
    registerHandlers(ctx);
    createWindow();
    void ctx.routingService.warmup();
    app.on('activate', () => { if (!state.window) createWindow(); });
    showCredentialWarning(ctx);
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (!state.window) return;
      if (state.window.isMinimized()) state.window.restore();
      state.window.focus();
    });
    bootstrap().catch(reportStartupFailure);
  }
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  let quitReady = false;
  let shuttingDown: Promise<void> | undefined;
  app.on('before-quit', (event) => {
    if (!state.context || quitReady) return;
    event?.preventDefault?.();
    shuttingDown ??= disposeMainContext(state.context).finally(() => { quitReady = true; app.quit(); });
    return shuttingDown;
  });
}

startApplication();
