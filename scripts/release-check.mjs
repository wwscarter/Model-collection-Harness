import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = ['dist/main/main.js', 'dist/preload/preload.cjs', 'dist/renderer/index.html'];
const missing = required.filter((entry) => !fs.existsSync(path.join(root, entry)));
if (missing.length) {
  console.error(`[release] missing build artifacts: ${missing.join(', ')}`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const electronRoot = path.dirname(require.resolve('electron/package.json'));
const electronPackage = JSON.parse(fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8'));
const platformPath = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron';
const executable = path.join(electronRoot, 'dist', platformPath);
const pathFile = path.join(electronRoot, 'path.txt');
if (!fs.existsSync(executable) || !fs.existsSync(pathFile) || fs.readFileSync(pathFile, 'utf8').trim() !== platformPath) {
  console.error(`[release] Electron ${electronPackage.version} is incomplete; run npm run doctor:electron`);
  process.exit(1);
}

const nativeSmokeScript = `
  const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
  const database = new Database(':memory:');
  try {
    const result = database.prepare('SELECT 1 AS value').get();
    if (result.value !== 1) throw new Error('SQLite smoke query returned an unexpected result');
    console.log('Electron ' + process.versions.electron + ', native ABI ' + process.versions.modules);
  } finally {
    database.close();
  }
`;
const nativeSmoke = spawnSync(executable, ['-e', nativeSmokeScript], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true,
});
if (nativeSmoke.error || nativeSmoke.status !== 0) {
  console.error(`[release] better-sqlite3 could not run under Electron ${electronPackage.version}; run npm install to restore the native binding before packaging`);
  if (nativeSmoke.error) console.error(`[release] native verification failed: ${nativeSmoke.error.message}`);
  if (nativeSmoke.signal) console.error(`[release] native verification was terminated by ${nativeSmoke.signal}`);
  if (nativeSmoke.stdout?.trim()) console.error(nativeSmoke.stdout.trim());
  if (nativeSmoke.stderr?.trim()) console.error(nativeSmoke.stderr.trim());
  process.exit(1);
}

console.log(`[release] verified ${required.length} build artifacts and better-sqlite3 query under ${nativeSmoke.stdout.trim()}`);

let ptyEntry;
try { ptyEntry = require.resolve('node-pty'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
if (ptyEntry) {
  // Loading node-pty alone does not exercise its separately spawned helper.
  // Use Electron and a real short-lived shell to catch helper/packaging failures.
  const ptySmokeScript = `
    const pty = require(${JSON.stringify(ptyEntry)});
    const windows = process.platform === 'win32';
    const terminal = pty.spawn(windows ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh',
      windows ? ['/d', '/q', '/c', 'echo NEWAI_PTY_READY'] : ['-c', 'printf NEWAI_PTY_READY'],
      { name: 'xterm-256color', cols: 80, rows: 24, cwd: ${JSON.stringify(root)}, env: process.env });
    let output = '';
    const timeout = setTimeout(() => {
      terminal.kill();
      console.error('PTY shell timed out');
      process.exitCode = 1;
    }, 5_000);
    terminal.onData((data) => { output += data; });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode !== 0 || !output.includes('NEWAI_PTY_READY')) {
        console.error('PTY shell failed to return its expected output (exit ' + exitCode + ')');
        process.exitCode = 1;
      } else {
        console.log('node-pty shell started and returned output');
      }
    });
  `;
  const ptySmoke = spawnSync(executable, ['-e', ptySmokeScript], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (ptySmoke.error || ptySmoke.status !== 0) {
    // node-pty is an optional dependency and the terminal entry point is not
    // shipped in the UI. A broken helper must not block a desktop build: the
    // TTY manager already degrades to the pipe adapter.
    console.warn('[release] node-pty could not start a terminal; continuing with the pipe fallback');
    if (ptySmoke.error) console.warn(`[release] PTY verification failed: ${ptySmoke.error.message}`);
    if (ptySmoke.signal) console.warn(`[release] PTY verification was terminated by ${ptySmoke.signal}`);
    if (ptySmoke.stdout?.trim()) console.warn(ptySmoke.stdout.trim());
    if (ptySmoke.stderr?.trim()) console.warn(ptySmoke.stderr.trim().split('\n').slice(0, 3).join('\n'));
  } else {
    console.log(`[release] verified ${ptySmoke.stdout.trim()} under Electron ${electronPackage.version}`);
  }
} else {
  console.log('[release] optional node-pty is absent; terminals will use the pipe adapter');
}
