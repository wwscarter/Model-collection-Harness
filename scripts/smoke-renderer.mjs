import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const required = ['dist/main/main.js', 'dist/preload/preload.cjs', 'dist/renderer/index.html'];
const missing = required.filter((file) => !existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`[smoke] missing build artifacts: ${missing.join(', ')}; run npm run build first`);
  process.exit(1);
}
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(root, 'scripts/smoke-electron.cjs')], { cwd: root, env, stdio: 'inherit' });
const timer = setTimeout(() => { console.error('[smoke] timed out'); child.kill('SIGKILL'); process.exit(1); }, 30_000);
child.on('exit', (code) => { clearTimeout(timer); process.exit(code ?? 1); });
child.on('error', (error) => { clearTimeout(timer); console.error('[smoke]', error.message); process.exit(1); });
