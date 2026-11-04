import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { downloadArtifact } from '@electron/get';

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === '1') {
  console.log('[electron] ELECTRON_SKIP_BINARY_DOWNLOAD=1; skipping binary repair');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const electronPackagePath = require.resolve('electron/package.json');
const electronRoot = path.dirname(electronPackagePath);
const electronPackage = JSON.parse(fs.readFileSync(electronPackagePath, 'utf8'));
const platform = process.env.npm_config_platform || process.platform;
let arch = process.env.npm_config_arch || process.arch;
if (platform === 'darwin' && process.platform === 'darwin' && arch === 'x64' && !process.env.npm_config_arch) {
  try {
    if (execFileSync('sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' }).trim() === '1') arch = 'arm64';
  } catch { /* sysctl is unavailable outside macOS/Rosetta */ }
}
const platformPath = platform === 'darwin' || platform === 'mas'
  ? 'Electron.app/Contents/MacOS/Electron'
  : platform === 'win32' ? 'electron.exe' : 'electron';
const distRoot = path.join(electronRoot, 'dist');
const executable = path.join(distRoot, platformPath);
const pathFile = path.join(electronRoot, 'path.txt');
const versionFile = path.join(distRoot, 'version');

// node-pty's prebuilt spawn-helper can arrive without executable permission.
// Repair it before development and packaging so posix_spawnp can launch a PTY.
if (process.platform !== 'win32') {
  let ptyRoot;
  try { ptyRoot = path.dirname(require.resolve('node-pty/package.json')); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  if (ptyRoot) {
    const prebuilds = path.join(ptyRoot, 'prebuilds');
    const directories = ['build/Release', 'build/Debug'];
    if (fs.existsSync(prebuilds)) {
      for (const entry of fs.readdirSync(prebuilds, { withFileTypes: true })) {
        if (entry.isDirectory()) directories.push(path.join('prebuilds', entry.name));
      }
    }
    for (const directory of directories) {
      const helper = path.join(ptyRoot, directory, 'spawn-helper');
      if (!fs.existsSync(helper)) continue;
      const stat = fs.statSync(helper);
      if (stat.isFile() && (stat.mode & 0o111) !== 0o111) {
        fs.chmodSync(helper, (stat.mode & 0o777) | 0o111);
        console.log(`[pty] restored executable permission: ${helper}`);
      }
    }
  }
}

function installed() {
  const installedVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim().replace(/^v/, '') : '';
  return installedVersion === electronPackage.version
    && fs.existsSync(executable)
    && fs.existsSync(pathFile)
    && fs.readFileSync(pathFile, 'utf8').trim() === platformPath;
}

if (installed()) {
  console.log(`[electron] binary ready: ${executable}`);
  process.exit(0);
}

if (platform !== process.platform && platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
  console.warn(`[electron] unsupported target platform ${platform}; leaving installation to the package manager`);
  process.exit(0);
}

const checksums = JSON.parse(fs.readFileSync(path.join(electronRoot, 'checksums.json'), 'utf8'));
const defaultCacheRoot = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Caches', 'electron')
  : process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache')
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron');
const cacheRoot = process.env.electron_config_cache || defaultCacheRoot;
console.log(`[electron] repairing ${platform}-${arch} binary using the verified artifact cache`);
const zipPath = await downloadArtifact({ version: electronPackage.version, artifactName: 'electron', platform, arch, cacheRoot, checksums, force: false });

fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(distRoot, { recursive: true });
try {
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${distRoot.replaceAll("'", "''")}' -Force`,
    ], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', distRoot], { stdio: 'inherit' });
  }
} catch (error) {
  throw new Error(`Could not extract the Electron artifact: ${error instanceof Error ? error.message : String(error)}`);
}
const bundledTypes = path.join(distRoot, 'electron.d.ts');
if (fs.existsSync(bundledTypes)) {
  fs.copyFileSync(bundledTypes, path.join(electronRoot, 'electron.d.ts'));
  fs.rmSync(bundledTypes);
}
fs.writeFileSync(pathFile, platformPath);
if (!installed()) throw new Error(`Electron extraction completed but executable is missing: ${executable}`);
console.log(`[electron] binary ready: ${executable}`);
