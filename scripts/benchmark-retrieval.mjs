import { build } from 'esbuild';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  model: { type: 'string', default: 'qwen3:0.6b' },
  'base-url': { type: 'string', default: 'http://127.0.0.1:11434/v1' },
  project: { type: 'string', default: root },
  target: { type: 'string', default: 'resolveVerifyCommands' },
  prompt: { type: 'string' },
  'timeout-ms': { type: 'string', default: '180000' },
  output: { type: 'string' },
} });
const baseURL = new URL(values['base-url']);
if (!['http:', 'https:'].includes(baseURL.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(baseURL.hostname) || baseURL.username || baseURL.password) throw new Error('This benchmark only accepts a local loopback model endpoint');
const timeoutMs = Number(values['timeout-ms']);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('--timeout-ms must be between 1000 and 300000');
const project = await fs.realpath(values.project);
const target = values.target;
if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(target)) throw new Error('--target must name an exported function');
const { rgPath } = await import('@vscode/ripgrep');
const located = spawnSync(rgPath, ['--no-config', '--line-number', '--glob', '*.{ts,tsx,js,jsx,mjs,cjs}', '-e', '^export (async )?function ' + target + '[(<]', '--', '.'], { cwd: project, encoding: 'utf8' });
if (located.status !== 0) throw new Error('Invalid benchmark: the requested exported function was not found in the project: ' + target);
const definitions = located.stdout.trim().split(String.fromCharCode(10)).map((line) => {
  const match = line.match(/^(.+?):([0-9]+):/);
  if (!match) throw new Error('Cannot parse the located definition');
  const relative = match[1].startsWith('./') ? match[1].slice(2) : match[1];
  return { path: relative.replaceAll(String.fromCharCode(92), '/'), line: Number(match[2]) };
});
const prompt = (values.prompt ?? '找到 ' + target + ' 的定义并解释它的判断逻辑。请通过文件工具确认位置，提供相对路径和函数名。').trimEnd() + String.fromCharCode(10) + '/no_think';
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).stdout?.trim();
const workingTreeChanges = spawnSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).stdout?.trim();
const cache = path.join(root, 'node_modules/.cache');
await fs.mkdir(cache, { recursive: true });
const artifacts = await fs.mkdtemp(path.join(cache, 'newai-retrieval-bench-'));
const output = values.output ? path.resolve(values.output) : await fs.mkdtemp(path.join(os.tmpdir(), 'newai-retrieval-bench-'));
await fs.mkdir(output, { recursive: true });
const cases = [];
const limits = { maxToolRounds: 16, maxToolCalls: 20, timeoutMs, maxOutputTokens: 1500, contextWindow: 32768 };

try {
  await build({ entryPoints: [path.join(root, 'src/core/bootstrap/createCore.ts')], outfile: path.join(artifacts, 'core.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', tsconfig: path.join(root, 'tsconfig.json'), logLevel: 'error' });
  for (const entry of ['index-worker.js', 'symbol-extractor.js']) {
    try { await fs.copyFile(path.join(root, 'dist/main', entry), path.join(artifacts, entry)); }
    catch { throw new Error('Run npm run build before benchmarking the production index worker'); }
  }
  const { createCore } = await import(pathToFileURL(path.join(artifacts, 'core.mjs')).href);
  const model = { id: 'local-retrieval-benchmark', name: 'Local retrieval benchmark', provider: 'custom', modelId: values.model, baseURL: baseURL.toString(), apiKey: '', enabled: true, priority: 0, capabilities: [{ type: 'code', score: 50 }], maxTokens: limits.maxOutputTokens, contextWindow: limits.contextWindow, temperature: 0, costPer1kTokens: { input: 0, output: 0 }, rateLimit: { requestsPerMinute: 0, tokensPerDay: 0 }, createdAt: new Date(), updatedAt: new Date() };
  const configurations = [['baseline', ['read', 'ls']], ['enhanced', ['read', 'ls', 'grep', 'find', 'code_symbols']]];
  for (const [label, names] of configurations) {
    const core = await createCore({ dataDir: path.join(output, label), secretKey: () => randomBytes(32), confirm: () => true, emit: () => {} }, { models: [model], persistModels: false, initializePresets: false, approvalMode: 'full', enableMcp: false });
    // Restrict the same normal runtime to each read-only loadout. These are
    // benchmark-local object settings; product runtime source is unchanged.
    const original = core.agentRuntime.tools.bind(core.agentRuntime);
    core.agentRuntime.tools = (...args) => original(...args).filter((tool) => names.includes(tool.name));
    Object.assign(core.agentRuntime.options, { maxToolRounds: limits.maxToolRounds, maxToolCalls: limits.maxToolCalls });
    const runId = 'retrieval-' + label;
    const started = Date.now();
    const sample = { label, tools: names, completed: false, durationMs: 0, toolCalls: 0 };
    const running = new Map();
    const evidence = [];
    console.log(JSON.stringify({ phase: 'started', label, tools: names, output }));
    try {
      const result = await core.run({ sessionId: runId, runId, prompt, pinnedModelId: model.id, includeProjectContext: false, verificationMode: 'off', planningMode: 'auto', enableTools: true }, {
        projectRoot: project, signal: AbortSignal.timeout(timeoutMs),
        emit(channel, payload) {
          if (channel === 'session:tool-call' && payload.status === 'running') console.log(JSON.stringify({ phase: 'tool', label, name: payload.toolName, args: payload.args }));
          if (channel !== 'session:tool-call') return;
          if (payload.status === 'running') running.set(payload.toolCallId, { name: payload.toolName, args: payload.args });
          else {
            evidence.push({ ...(running.get(payload.toolCallId) ?? { name: payload.toolName }), status: payload.status, summary: payload.summary });
            running.delete(payload.toolCallId);
          }
        },
      });
      Object.assign(sample, { answer: result.output, stopReason: result.stopReason, completed: !['tool_limit', 'budget_limit', 'length'].includes(result.stopReason) });
    } catch (error) { sample.error = error instanceof Error ? error.message : String(error); }
    finally {
      const trace = core.traceRecorder.getTrace(runId);
      sample.durationMs = Date.now() - started;
      sample.toolCalls = trace?.spans.filter((span) => span.kind === 'tool').length ?? 0;
      sample.toolSpans = trace?.spans.filter((span) => span.kind === 'tool').map((span) => ({ name: span.name, status: span.status, attributes: span.attributes })) ?? [];
      sample.toolEvidence = evidence;
      const readDefinition = evidence.some((event) => event.status === 'completed' && event.name === 'read' && typeof event.args?.path === 'string' && definitions.some((definition) => {
        const expected = path.resolve(project, definition.path);
        const actual = path.resolve(project, event.args.path);
        const start = Number(event.args.offset ?? 1);
        const end = event.args.limit === undefined ? Infinity : start + Number(event.args.limit) - 1;
        return expected === actual && start <= definition.line && definition.line <= end;
      }));
      const searchDefinition = evidence.some((event) => event.status === 'completed' && ['grep', 'code_symbols'].includes(event.name) && String(event.summary).includes(target) && definitions.some((definition) => String(event.summary).includes(definition.path)));
      const answer = String(sample.answer ?? '');
      sample.correctnessChecks = {
        mentionsTarget: answer.includes(target),
        mentionsDefinitionPath: definitions.some((definition) => answer.includes(definition.path)),
        sourceEvidence: readDefinition || searchDefinition,
      };
      sample.correctnessChecks.automaticPassed = sample.completed && Object.values(sample.correctnessChecks).every(Boolean);
      await fs.writeFile(path.join(output, label + '-trace.json'), JSON.stringify({ ...sample, trace }, null, 2));
      cases.push(sample);
      console.log(JSON.stringify({ phase: 'finished', ...sample }));
      await core.dispose();
    }
  }
  const comparable = cases.every((sample) => sample.correctnessChecks.automaticPassed) && cases[0].toolCalls > 0;
  const report = {
    createdAt: new Date().toISOString(), repository: project, revision, workingTreeChanges, target, definitions, model: values.model, baseURL: baseURL.origin, prompt, temperature: 0, limits, cases,
    toolCountReductionPercent: comparable ? (cases[0].toolCalls - cases[1].toolCalls) / cases[0].toolCalls * 100 : null,
    correctnessReviewRequired: true,
    note: 'One actual local-model run per toolset, with the same prompt ending in /no_think and no path hint. Definition existence is checked before inference. Automatic checks require the target name, correct path and successful source-tool evidence; explanation accuracy still requires manual review. No synthetic inference or tool results. Counts come from the production core trace. SDK-default reasoning options are unchanged for both cases. A completed response is not itself a correct answer.',
  };
  const reportPath = path.join(output, 'report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase: 'report', file: reportPath, completed: cases.map((sample) => sample.completed), toolCountReductionPercent: report.toolCountReductionPercent }));
  if (!comparable) process.exitCode = 1;
} finally { await fs.rm(artifacts, { recursive: true, force: true }); }
