import { Worker } from 'node:worker_threads';
import type { ProjectSearchRequest, ProjectSearchResult } from './projectSearchTypes';

// Regex evaluation is isolated from Electron's event loop and can always be
// terminated by the caller's deadline, including while a regexp is running.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
(async () => {
  const request = workerData;
  const regex = request.literal ? null : new RegExp(request.pattern, request.ignoreCase ? 'iu' : 'u');
  const needle = request.ignoreCase ? request.pattern.toLowerCase() : request.pattern;
  const result = { lines: [], matches: 0, truncated: false, backend: 'node' };
  let outputChars = 0;
  let stop = false;
  for (const file of request.files) {
    let handle;
    let content;
    try {
      handle = await fs.promises.open(file.absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > request.maxFileBytes) { result.truncated = true; continue; }
      const buffer = Buffer.alloc(Math.min(request.maxFileBytes + 1, stat.size + 1));
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      if (bytes > request.maxFileBytes || bytes > stat.size) { result.truncated = true; continue; }
      const data = buffer.subarray(0, bytes);
      if (data.includes(0)) continue;
      content = data.toString('utf8');
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'EISDIR'].includes(error.code)) throw error;
      result.truncated = true;
      continue;
    } finally { if (handle) await handle.close(); }
    const normalized = content.replace(/\r\n/g, '\n');
    const lines = normalized ? normalized.split('\n') : [];
    if (normalized.endsWith('\n')) lines.pop();
    const emitted = new Set();
    for (let index = 0; index < lines.length; index++) {
      const candidate = request.ignoreCase ? lines[index].toLowerCase() : lines[index];
      const match = request.literal ? candidate.includes(needle) : regex.test(lines[index]);
      if (!match) continue;
      result.matches++;
      if (result.matches > request.limit) { result.matches--; result.truncated = true; stop = true; break; }
      for (let line = Math.max(0, index - request.context); line <= Math.min(lines.length - 1, index + request.context); line++) {
        if (emitted.has(line)) {
          if (line === index) {
            const prior = result.lines.find(item => item.path === file.path && item.line === line + 1);
            if (prior) prior.match = true;
          }
          continue;
        }
        emitted.add(line);
        const text = lines[line].length > 500 ? lines[line].slice(0, 500) + ' [truncated]' : lines[line];
        outputChars += text.length + file.path.length + 20;
        result.lines.push({ path: file.path, line: line + 1, text, match: line === index });
        if (outputChars > 16000) { result.truncated = true; stop = true; break; }
      }
      if (stop) break;
    }
    if (stop) break;
  }
  parentPort.postMessage({ result });
})().catch(error => parentPort.postMessage({ error: error.message || String(error) }));
`;

/** The worker receives only the scanner's file allowlist, never a search directory. */
export function searchWithNode(request: ProjectSearchRequest): Promise<ProjectSearchResult> {
  request.signal?.throwIfAborted();
  if (!request.files.length) return Promise.resolve({ lines: [], matches: 0, truncated: false, backend: 'node' });
  const { signal, ...data } = request;
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: data, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let settled = false;
    const finish = (error?: unknown, result?: ProjectSearchResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate().catch(() => undefined);
      if (error) reject(error); else resolve(result!);
    };
    const onAbort = () => finish(signal?.reason ?? new Error('搜索已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    worker.once('message', (message: { error?: string; result?: ProjectSearchResult }) => {
      if (message.error) finish(new Error(message.error)); else finish(undefined, message.result);
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => { if (!settled) finish(new Error('搜索进程提前退出：' + code)); });
  });
}
