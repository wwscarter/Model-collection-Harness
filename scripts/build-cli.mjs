import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const common = { bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', sourcemap: true, tsconfig: path.join(root, 'tsconfig.json'), logLevel: 'warning' };
await build({ ...common, entryPoints: [path.join(root, 'src/cli/index.ts')], outfile: path.join(root, 'dist/cli/newai.mjs'), banner: { js: '#!/usr/bin/env node' } });
await build({ ...common, entryPoints: { 'index-worker': path.join(root, 'src/core/codebase/IndexWorker.ts'), 'symbol-extractor': path.join(root, 'src/core/codebase/SymbolExtractor.ts') }, outdir: path.join(root, 'dist/cli') });
fs.chmodSync(path.join(root, 'dist/cli/newai.mjs'), 0o755);
