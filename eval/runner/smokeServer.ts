import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ModelConfig } from '../../src/core/models/ModelConfig';
import type { EvalTask } from './types';

/** An explicitly synthetic local SSE server exercises the real agent/tool loop. */
export async function startSmokeServer(task: EvalTask): Promise<{ model: ModelConfig; close(): Promise<void> }> {
  const replay = JSON.parse(fs.readFileSync(path.join(task.directory, 'smoke.json'), 'utf8')) as { calls: Array<{ name: string; args: Record<string, unknown> }>; answer: string };
  let turn = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const call = replay.calls[turn++];
      const delta = call ? { tool_calls: [{ index: 0, id: 'smoke-' + turn, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: replay.answer };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const model: ModelConfig = { id: 'synthetic-smoke', name: 'Synthetic framework smoke', provider: 'custom', modelId: 'synthetic-smoke', baseURL: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1', apiKey: '', enabled: true, priority: 0, capabilities: [{ type: 'code', score: 50 }], maxTokens: 4096, contextWindow: 64000, costPer1kTokens: { input: 0, output: 0 }, rateLimit: { requestsPerMinute: 0, tokensPerDay: 0 }, createdAt: new Date(), updatedAt: new Date() };
  return { model, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
