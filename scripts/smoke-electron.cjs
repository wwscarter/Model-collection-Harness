const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const logs = [];
const originalError = console.error;
console.error = (...args) => {
  if (args.some((value) => String(value).includes('No handler registered'))) logs.push({ level: 'error', message: args.map(String).join(' ') });
  originalError(...args);
};
const fail = (message) => { console.error('SMOKE_FAIL', message); app.exit(1); };
const timeout = setTimeout(() => fail('timed out'), 20_000);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const empty = () => [];
  for (const channel of ['model:list', 'session:list', 'session:plans-list', 'projects:list']) ipcMain.handle(channel, empty);
  ipcMain.handle('project:current', () => undefined);
  ipcMain.handle('project:clear', () => ({ success: true }));
  ipcMain.handle('checkpoints:latest', (_event, sessionId) => ({ runId: 'smoke', sessionId, status: 'completed' }));
  ipcMain.handle('preferences:get', () => ({ approvalMode: 'ask' }));
  ipcMain.handle('routing:status', () => ({ backend: 'heuristic', available: false }));
  ipcMain.handle('trace:get', () => undefined);
  ipcMain.handle('trace:recent', empty);
  ipcMain.handle('memory:list', empty);
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(ROOT, 'dist/preload/preload.cjs'),
    contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
  } });
  win.webContents.on('console-message', ({ level, message }) => logs.push({ level, message }));
  win.webContents.on('did-fail-load', (_event, code, description, url) => fail(`load ${code} ${description} ${url}`));
  win.webContents.on('render-process-gone', (_event, details) => fail(`renderer gone ${JSON.stringify(details)}`));
  await win.loadFile(path.join(ROOT, 'dist/renderer/index.html'));
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const result = await win.webContents.executeJavaScript(`(async () => ({
    amd: typeof window.amd,
    trace: typeof window.amd?.trace,
    memory: typeof window.amd?.memory,
    checkpoint: (await window.amd.checkpoints.latest('smoke')).status,
    terminal: typeof window.amd.tty,
    rootChildren: document.getElementById('root')?.children.length ?? -1,
  }))()`);
  const errors = logs.filter((entry) => entry.level === 'warning' || entry.level === 'error');
  if (result.amd !== 'object' || result.trace !== 'object' || result.memory !== 'object' || result.checkpoint !== 'completed' || result.terminal !== 'undefined' || result.rootChildren < 1) {
    fail(`unexpected renderer state ${JSON.stringify(result)} logs=${JSON.stringify(logs)}`);
    return;
  }
  if (errors.length) { fail(`console errors ${JSON.stringify(errors)}`); return; }
  clearTimeout(timeout);
  console.log('SMOKE_OK', JSON.stringify(result));
  app.exit(0);
}).catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
