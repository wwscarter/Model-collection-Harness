import fs from 'node:fs';
import { createCore } from '@core/bootstrap/createCore';
import { readEnvironmentModel } from '@core/bootstrap/environmentModel';
import type { Core } from '@core/bootstrap/createCore';
import { normalizeMediaArtifacts } from '@core/media/MediaTypes';
import { parseCliArguments, CLI_HELP } from './arguments';
import { createCliHost, type CliIO } from './host';

export interface CliDependencies {
  createCore?: typeof createCore;
  eval?: (args: ReturnType<typeof parseCliArguments>, signal: AbortSignal) => Promise<unknown>;
}

/** One invocation; callers retain ownership of process exit and terminal streams. */
export async function runCli(argv: string[], io: CliIO = process, dependencies: CliDependencies = {}): Promise<number> {
  let core: Core | undefined;
  let args: ReturnType<typeof parseCliArguments> | undefined;
  const controller = new AbortController();
  const interrupt = () => { controller.abort(new Error('任务已取消')); core?.cancel(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    args = parseCliArguments(argv);
    if (args.command === 'help') { io.stdout.write(CLI_HELP + '\n'); return 0; }
    if (args.command === 'eval') {
      if (!dependencies.eval) throw new Error('当前构建未包含评测入口');
      const report = await dependencies.eval(args, controller.signal);
      if (args.json) io.stdout.write(JSON.stringify({ channel: 'eval:completed', payload: report }) + '\n');
      else io.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return controller.signal.aborted ? 130 : (report as { passed?: boolean } | undefined)?.passed === false ? 1 : 0;
    }
    if (args.project && !fs.statSync(args.project).isDirectory()) throw new Error('项目目录不存在：' + args.project);
    const environmentModel = readEnvironmentModel();
    core = await (dependencies.createCore ?? createCore)(createCliHost(args, io, controller.signal), { approvalMode: args.approval, ...(environmentModel ? { models: [environmentModel], persistModels: false } : {}) });
    if (args.command === 'models') {
      const models = core.registry.getAllModels().map((model) => ({ id: model.id, name: model.name, provider: model.provider, modelId: model.modelId, enabled: model.enabled, credentialStatus: model.credentialError ? 'unavailable' : model.apiKey ? 'configured' : model.provider === 'custom' ? 'keyless' : 'missing' }));
      if (args.json) io.stdout.write(JSON.stringify({ channel: 'models:list', payload: models }) + '\n');
      else for (const model of models) io.stdout.write([model.enabled ? '启用' : '停用', model.id, model.name, model.credentialStatus].join('\t') + '\n');
      return 0;
    }
    if (args.command === 'trace') {
      const trace = core.observability.getTrace(args.runId!);
      if (!trace) throw new Error('未找到运行记录：' + args.runId);
      if (args.json) io.stdout.write(JSON.stringify({ channel: 'trace:show', payload: trace }) + '\n');
      else io.stdout.write(JSON.stringify(trace, null, 2) + '\n');
      return 0;
    }
    const output = await core.run({ prompt: args.prompt!, ...(args.model ? { pinnedModelId: args.model } : {}), ...(args.planningMode ? { planningMode: args.planningMode } : {}) }, { projectRoot: args.project, signal: controller.signal });
    const now = new Date();
    core.sessionStorage.save({ id: String(output.sessionId), title: args.prompt!.slice(0, 80), prompt: args.prompt!, output: String(output.output ?? ''), messages: [
      { id: String(output.runId) + '-user', role: 'user', content: args.prompt! },
      { id: String(output.assistantMessageId ?? String(output.runId) + '-assistant'), role: 'assistant', content: String(output.output ?? ''), artifacts: normalizeMediaArtifacts(output.artifacts) },
    ], runId: String(output.runId), projectRoot: args.project, modelUsed: String((output.modelUsed as { id?: string } | undefined)?.id ?? ''), metrics: output.metrics, createdAt: now, updatedAt: now });
    if (!args.json) for (const artifact of normalizeMediaArtifacts(output.artifacts)) io.stdout.write('素材：' + core.media.getAssetPath(artifact.id) + String.fromCharCode(10));
    return ['tool_limit', 'budget_limit', 'length', 'media_incomplete'].includes(String(output.stopReason)) || (output.projectVerification as { status?: string } | undefined)?.status === 'failed' ? 1 : 0;
  } catch (error) {
    const message = controller.signal.aborted ? '任务已取消' : error instanceof Error ? error.message : String(error);
    if (args?.json || argv.includes('--json')) io.stdout.write(JSON.stringify({ channel: 'error', payload: { message, cancelled: controller.signal.aborted } }) + '\n');
    else io.stderr.write(message + '\n');
    return controller.signal.aborted ? 130 : 1;
  } finally {
    await core?.dispose();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
