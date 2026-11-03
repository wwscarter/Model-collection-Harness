import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

// better-sqlite3 13 uses Node-API, so Node and Electron share the same binding.
const test = spawnSync(process.execPath, [vitest, 'run', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
if (test.error) console.error(test.error.message);
process.exit(test.status ?? 1);
