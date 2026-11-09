import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SemanticSearch } from '../../src/core/codebase/SemanticSearch';
import { DEFAULT_CODE_SEARCH_CONFIG, loadCodeSearchConfig, saveCodeSearchConfig, validateCodeSearchConfig } from '../../src/core/codebase/CodeSearchConfig';
import { chunkFile, cosine, reciprocalRankFusion } from '../../src/core/codebase/SemanticChunks';
import { EmbeddingClient } from '../../src/core/codebase/EmbeddingClient';

let directory: string;
let root: string;
let server: http.Server;
let baseURL: string;
let digest: string;
let capability: string;
let requests: string[];
let embedded: string[];
let holdEmbeds: boolean;
let embeddingStarted: (() => void) | undefined;
const sockets = new Set<Socket>();
const services: SemanticSearch[] = [];

const vector = (text: string): number[] => /greet|hello|welcome/i.test(text) ? [1, 0, 0] : /sum|add|total/i.test(text) ? [0, 1, 0] : [0, 0, 1];
const createSearch = (patch = {}) => {
  const config = { ...DEFAULT_CODE_SEARCH_CONFIG, enabled: true, model: 'embed-test', ...patch };
  const search = new SemanticSearch({ dataDir: path.join(directory, 'data'), getConfig: () => config, getBaseURL: () => baseURL });
  services.push(search);
  return search;
};

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-semantic-'));
  root = path.join(directory, 'project');
  fs.mkdirSync(root);
  digest = 'model-version-one'; capability = 'embedding'; requests = []; embedded = []; holdEmbeds = false; embeddingStarted = undefined;
  server = http.createServer(async (request, response) => {
    requests.push(request.url!);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'embed-test:latest', digest }] })); return; }
    if (request.url === '/api/show') { response.end(JSON.stringify({ capabilities: [capability] })); return; }
    if (request.url !== '/api/embed') { response.writeHead(404).end('{}'); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as { input: string[]; model: string; truncate: boolean };
    embedded.push(...input.input);
    embeddingStarted?.();
    if (holdEmbeds) return;
    response.end(JSON.stringify({ model: input.model, embeddings: input.input.map(vector) }));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.resolve();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('local semantic code retrieval', () => {
  it('keeps retrieval disabled until an embedding model is selected and enabled', async () => {
    const file = path.join(directory, 'code-search.json');
    expect(loadCodeSearchConfig(file).enabled).toBe(false);
    const disabled = createSearch({ enabled: false, model: '' });
    expect((await disabled.search(root, 'hello')).status).toBe('disabled');
    expect(requests).toEqual([]);
    expect(validateCodeSearchConfig(DEFAULT_CODE_SEARCH_CONFIG)).toEqual(DEFAULT_CODE_SEARCH_CONFIG);
    expect(() => validateCodeSearchConfig({ ...DEFAULT_CODE_SEARCH_CONFIG, enabled: true })).toThrow('请选择');
    const config = saveCodeSearchConfig(file, { ...DEFAULT_CODE_SEARCH_CONFIG, enabled: true, model: 'embed-test' });
    expect(loadCodeSearchConfig(file)).toEqual(config);
  });

  it('embeds ordinary source locally and fuses lexical and cosine candidates', async () => {
    fs.writeFileSync(path.join(root, 'hello.ts'), 'export function greetUser() { return "Hello user"; }');
    fs.writeFileSync(path.join(root, 'sum.ts'), 'export const sum = (left: number, right: number) => left + right;');
    const search = createSearch();
    const result = await search.search(root, 'welcome greeting');
    expect(result.status).toBe('ready');
    expect(result.indexedFiles).toBe(2);
    expect(result.indexedChunks).toBe(2);
    expect(result.hits[0].path).toBe('hello.ts');
    expect(result.hits[0]).toMatchObject({ line: 1, endLine: 1 });
    expect(result.hits[0].text).toContain('greetUser');
    expect(requests.every((url) => ['/api/tags', '/api/show', '/api/embed'].includes(url))).toBe(true);
    expect(search.getStatus()).toEqual(result);
  });

  it('persists embeddings and reuses both file and query vectors across instances', async () => {
    fs.writeFileSync(path.join(root, 'hello.ts'), 'export const greeting = "hello";');
    const first = createSearch();
    await first.search(root, 'welcome greeting');
    const used = embedded.length;
    await first.search(root, 'welcome greeting');
    expect(embedded).toHaveLength(used);
    first.close();
    await Promise.resolve();
    const reopened = createSearch();
    expect((await reopened.search(root, 'welcome greeting')).hits[0].path).toBe('hello.ts');
    expect(embedded).toHaveLength(used);
  });

  it('refreshes changed files, removes deleted chunks and invalidates a replaced model', async () => {
    const file = path.join(root, 'hello.ts');
    fs.writeFileSync(file, 'export const greeting = "hello";');
    const search = createSearch();
    await search.search(root, 'greeting');
    fs.writeFileSync(file, 'export const greeting = "hello again";');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 2_000));
    expect((await search.search(root, 'greeting')).hits[0].text).toContain('again');
    const used = embedded.length;
    digest = 'model-version-two';
    await search.search(root, 'greeting');
    expect(embedded.length).toBeGreaterThan(used);
    fs.unlinkSync(file);
    const deleted = await search.search(root, 'greeting');
    expect(deleted.indexedChunks).toBe(0);
    expect(deleted.hits).toEqual([]);
  });

  it('uses supplied symbol boundaries and reports a bounded index', async () => {
    const text = ['// header', 'export function greet() {', '  return "hello";', '}', 'export const sum = 4;'].join('\n');
    fs.writeFileSync(path.join(root, 'code.ts'), text);
    const search = createSearch({ maxChunks: 1 });
    const result = await search.search(root, 'greeting', { symbols: [
      { name: 'greet', kind: 'function', path: 'code.ts', line: 2, endLine: 4, signature: 'function greet()' },
      { name: 'sum', kind: 'variable', path: 'code.ts', line: 5, endLine: 5, signature: 'const sum = 4' },
    ] });
    expect(result.truncated).toBe(true);
    expect(result.indexedChunks).toBe(1);
    expect(result.hits[0]).toMatchObject({ line: 2, endLine: 4, signature: 'function greet()' });
    expect(result.hits[0].text).not.toContain('header');
  });

  it('also retrieves imports, module constants and initialization outside indexed symbols', async () => {
    const source = [
      'import { initializeWorkspace } from "./workspace";',
      'const retryLimit = 5;',
      'export function greet() {',
      '  return "hello";',
      '}',
      'initializeWorkspace(retryLimit);',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'startup.ts'), source);
    const search = createSearch();
    const symbols = [{ name: 'greet', kind: 'function', path: 'startup.ts', line: 3, endLine: 5, signature: 'function greet()' }];
    const constants = await search.search(root, 'retryLimit', { symbols });
    expect(constants.status).toBe('ready');
    expect(constants.hits.some((hit) => hit.text.includes('const retryLimit = 5'))).toBe(true);
    const startup = await search.search(root, 'initializeWorkspace', { symbols });
    expect(startup.hits.some((hit) => hit.text.includes('import { initializeWorkspace }'))).toBe(true);
    expect(startup.hits.some((hit) => hit.line === 6 && hit.text === 'initializeWorkspace(retryLimit);')).toBe(true);
  });

  it('uses a per-run configuration and endpoint snapshot until the next run', async () => {
    fs.writeFileSync(path.join(root, 'hello.ts'), 'export const greeting = "hello";');
    const config = { ...DEFAULT_CODE_SEARCH_CONFIG, enabled: true, model: 'embed-test' };
    const search = new SemanticSearch({ dataDir: path.join(directory, 'data'), getConfig: () => ({ ...DEFAULT_CODE_SEARCH_CONFIG }), getBaseURL: () => 'http://127.0.0.1:1' });
    services.push(search);
    const current = await search.search(root, 'greeting', { config, baseURL });
    expect(current.status).toBe('ready');
    const next = await search.search(root, 'greeting');
    expect(next.status).toBe('disabled');
    expect(requests.filter((route) => route === '/api/embed')).toHaveLength(2);
  });

  it('reports an unavailable local model without attempting embeddings', async () => {
    capability = 'completion';
    fs.writeFileSync(path.join(root, 'hello.ts'), 'export const greeting = "hello";');
    const result = await createSearch().search(root, 'greeting');
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('embedding');
    expect(embedded).toEqual([]);
    expect(result.hits).toEqual([]);
  });

  it('honors cancellation while the local model is processing and can retry', async () => {
    holdEmbeds = true;
    fs.writeFileSync(path.join(root, 'hello.ts'), 'export const greeting = "hello";');
    const search = createSearch();
    const controller = new AbortController();
    const started = new Promise<void>((resolve) => { embeddingStarted = resolve; });
    const pending = search.search(root, 'greeting', { signal: controller.signal });
    await started;
    controller.abort(new Error('synthetic cancellation'));
    await expect(pending).rejects.toThrow('synthetic cancellation');
    holdEmbeds = false;
    const result = await search.search(root, 'greeting');
    expect(result.status).toBe('ready');
    expect(result.indexedChunks).toBe(1);
  });

  it('bounds local embedding requests with a timeout and supports draft probing', async () => {
    const client = new EmbeddingClient(baseURL, 'embed-test', 250);
    expect(await client.probe()).toEqual({ model: 'embed-test', digest });
    holdEmbeds = true;
    await expect(client.embed(['ordinary source'])).rejects.toThrow('超时');
  });
});

describe('chunking and reciprocal rank fusion', () => {
  it('splits ordinary files into bounded line ranges and chunks large declarations', () => {
    const text = Array.from({ length: 170 }, (_, index) => 'const item' + index + ' = ' + index + ';').join('\n');
    const chunks = chunkFile('example.ts', text);
    expect(chunks.map((chunk) => [chunk.line, chunk.endLine])).toEqual([[1, 80], [81, 160], [161, 170]]);
    expect(chunks.every((chunk) => chunk.text.length <= 6_000)).toBe(true);
  });

  it('ranks overlap in two recall lists above single-list matches', () => {
    const combined = reciprocalRankFusion(['lexical-only', 'both'], ['both', 'semantic-only'], 3);
    expect(combined[0].id).toBe('both');
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});
