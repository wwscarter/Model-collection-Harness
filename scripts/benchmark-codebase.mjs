import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { files: { type: 'string', default: '10000' } } });
const fileCount = Number(values.files);
if (!Number.isSafeInteger(fileCount) || fileCount < 1 || fileCount > 50_000) throw new Error('--files must be an integer between 1 and 50000');
const entries = ['index-worker.js', 'symbol-extractor.js'];
for (const entry of entries) {
  try { await fs.access(path.join(root, 'dist/main', entry)); }
  catch { throw new Error('Run npm run build before benchmarking the production index worker'); }
}

const { build } = await import('esbuild');
const cache = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cache, { recursive: true });
const artifacts = await fs.mkdtemp(path.join(cache, 'newai-index-bench-'));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'newai-index-bench-'));
const project = path.join(directory, 'project');
const digits = Math.max(5, String(fileCount - 1).length);
let index;

try {
  await fs.mkdir(project);
  // Build only the public index API for the benchmark harness. Both worker
  // modules are copied verbatim from the actual Electron production build.
  await build({
    entryPoints: { 'codebase-index': path.join(root, 'src/core/codebase/CodebaseIndex.ts') },
    outdir: artifacts, bundle: true, packages: 'external', platform: 'node', format: 'esm',
    target: 'node22', tsconfig: path.join(root, 'tsconfig.json'),
  });
  for (const entry of entries) await fs.copyFile(path.join(root, 'dist/main', entry), path.join(artifacts, entry));
  for (let offset = 0; offset < fileCount; offset += 100) {
    await Promise.all(Array.from({ length: Math.min(100, fileCount - offset) }, (_, current) => {
      const id = String(offset + current).padStart(digits, '0');
      return fs.writeFile(path.join(project, 'unit' + id + '.ts'), 'export function IndexedFunction' + id + '(value: number): number { return value + 1; }\n');
    }));
  }
  const { CodebaseIndex } = await import(pathToFileURL(path.join(artifacts, 'codebase-index.js')).href);
  index = new CodebaseIndex(path.join(directory, 'data'));
  let last = performance.now();
  let maximumDelay = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maximumDelay = Math.max(maximumDelay, now - last - 5);
    last = now;
  }, 5);
  try {
    const first = await index.refresh(project);
    const unchanged = await index.refresh(project);
    const firstId = '0'.repeat(digits);
    await fs.writeFile(path.join(project, 'unit' + firstId + '.ts'), 'export function UpdatedFunction' + firstId + '(value: number): number { return value + 2; }\n');
    const incremental = await index.refresh(project, ['unit' + firstId + '.ts']);
    const expectedName = fileCount === 1 ? 'UpdatedFunction' + firstId : 'IndexedFunction' + String(fileCount - 1).padStart(digits, '0');
    const queried = await index.symbols(project, expectedName);
    const listed = await index.symbols(project, '', undefined, 100_000);
    if (first.indexed !== fileCount || first.symbols !== fileCount || incremental.indexed !== 1 || queried.length !== 1 || listed.length !== fileCount) throw new Error('Benchmark fixture counts or symbol lookup did not match expectations');
    console.log(JSON.stringify({
      fixture: 'generated TypeScript functions', files: fileCount, node: process.versions.node,
      worker: 'dist/main/index-worker.js', extractor: 'dist/main/symbol-extractor.js',
      first, unchanged, incremental, matchedSymbols: queried.length, listedSymbols: listed.length,
      maxMainThreadDelayMs: Math.max(0, Math.round(maximumDelay)),
    }, null, 2));
  } finally { clearInterval(timer); }
} finally {
  index?.dispose();
  await fs.rm(directory, { recursive: true, force: true });
  await fs.rm(artifacts, { recursive: true, force: true });
}
