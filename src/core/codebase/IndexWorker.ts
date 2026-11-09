import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import type { IndexedFile, WorkerRequest, WorkerResponse } from './CodebaseTypes';
import type { SymbolExtractor } from './SymbolExtractor';

const port = parentPort;
if (!port) throw new Error('IndexWorker must run in a worker thread');

// The compiled entry and the source-test entry use the same worker. Passing a
// URL avoids Node-specific TypeScript extension resolution in the source path.
const module = await import(workerData.extractorUrl) as { SymbolExtractor: new (grammarRoot?: string) => SymbolExtractor };
const extractor = new module.SymbolExtractor(workerData.grammarRoot);
let queue = Promise.resolve();

async function indexFiles(request: WorkerRequest): Promise<WorkerResponse> {
  const files: IndexedFile[] = [];
  for (const file of request.files) {
    try {
      const before = await fs.stat(file.absolutePath);
      if (before.size > 2 * 1024 * 1024) throw new Error('File exceeds the 2 MB index limit');
      const content = await fs.readFile(file.absolutePath);
      if (content.includes(0)) throw new Error('Binary files are not indexed');
      const result = await extractor.extract(file.path, content.toString('utf8'));
      const after = await fs.stat(file.absolutePath);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('File changed while indexing; retry refresh');
      files.push({ ...file, mtimeMs: after.mtimeMs, size: after.size, hash: createHash('sha256').update(content).digest('hex'), symbols: result.symbols, truncated: result.truncated });
    } catch (error) {
      files.push({ ...file, hash: '', symbols: [], truncated: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { id: request.id, files };
}

port.on('message', (request: WorkerRequest) => {
  queue = queue.then(async () => {
    try { port.postMessage(await indexFiles(request)); }
    catch (error) { port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse); }
  });
});
port.on('close', () => extractor.dispose());
