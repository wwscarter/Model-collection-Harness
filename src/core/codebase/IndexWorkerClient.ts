import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { awaitWithSignal } from '../tools/awaitWithSignal';
import type { IndexFile, IndexedFile, WorkerResponse } from './CodebaseTypes';

interface PendingRequest {
  resolve(files: IndexedFile[]): void;
  reject(error: Error): void;
  cleanup(): void;
}

export class IndexWorkerClient {
  private worker?: Worker;
  private pending = new Map<number, PendingRequest>();
  private sequence = 0;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();

  private start(): Worker {
    if (this.disposed) throw new Error('Codebase index is disposed');
    if (this.worker) return this.worker;
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const bundled = path.join(directory, 'index-worker.js');
    const compiled = fs.existsSync(bundled);
    const entry = compiled ? bundled : path.join(directory, 'IndexWorker.ts');
    if (!compiled) {
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 22 || (major === 22 && minor < 6)) throw new Error('Source indexing requires Node 22.6+; use the compiled application on earlier Node 22 versions');
    }
    const worker = new Worker(pathToFileURL(entry), {
      execArgv: compiled ? [] : ['--experimental-strip-types'],
      workerData: {
        extractorUrl: pathToFileURL(path.join(directory, compiled ? 'symbol-extractor.js' : 'SymbolExtractor.ts')).href,
        grammarRoot: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
          ? path.join((process as NodeJS.Process & { resourcesPath: string }).resourcesPath, 'codebase-grammars') : undefined,
      },
    });
    worker.on('message', (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup();
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.files ?? []);
      if (!this.pending.size) worker.unref();
    });
    worker.on('error', (error) => this.fail(worker, error));
    worker.on('exit', (code) => this.fail(worker, new Error('Symbol index worker exited (' + code + ')')));
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const request of this.pending.values()) { request.cleanup(); request.reject(error); }
    this.pending.clear();
  }

  async extract(files: IndexFile[], signal?: AbortSignal): Promise<IndexedFile[]> {
    signal?.throwIfAborted();
    // Only the active request reaches the worker. Cancelling it cannot reject
    // another project's queued request; that request starts on a fresh worker.
    const work = this.queue.then(() => this.extractNow(files, signal));
    this.queue = work.then(() => undefined, () => undefined);
    return await awaitWithSignal(work, signal);
  }

  private async extractNow(files: IndexFile[], signal?: AbortSignal): Promise<IndexedFile[]> {
    signal?.throwIfAborted();
    const worker = this.start();
    const id = ++this.sequence;
    return await new Promise<IndexedFile[]>((resolve, reject) => {
      const abort = () => {
        this.fail(worker, signal?.reason instanceof Error ? signal.reason : new Error('Symbol indexing cancelled'));
        void worker.terminate();
      };
      const timer = setTimeout(() => { this.fail(worker, new Error('Symbol index batch exceeded 60 seconds')); void worker.terminate(); }, 60_000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      worker.ref();
      worker.postMessage({ id, files });
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.worker) {
      const worker = this.worker;
      this.fail(worker, new Error('Codebase index is disposed'));
      void worker.terminate();
    }
  }
}
