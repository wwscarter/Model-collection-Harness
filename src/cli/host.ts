import { createInterface } from 'node:readline/promises';
import type { CoreApprovalRequest, CoreHost } from '@core/bootstrap/createCore';
import type { CliArguments } from './arguments';

export interface CliIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

function approvalDetails(request: CoreApprovalRequest): string {
  if (request.kind === 'plan') return '执行计划：\n' + request.plan.plan.steps.map((step, index) => (index + 1) + '. ' + step.title + (step.detail ? '：' + step.detail : '')).join('\n');
  if (request.kind === 'tool') return '工具：' + request.toolName + '\n项目：' + (request.projectRoot ?? '应用工作区') + '\n' + JSON.stringify(request.input, null, 2).slice(0, 4000);
  if (request.kind === 'command') return '命令：' + request.command + '\n目录：' + request.cwd + '\n' + request.decision.reason;
  return '项目验证：' + request.projectRoot + '\n' + request.commands.map((command) => command.label + ': ' + command.command).join('\n');
}

export function createCliHost(args: CliArguments, io: CliIO, signal: AbortSignal): CoreHost {
  let streamed = '';
  return {
    dataDir: args.dataDir,
    emit(channel, payload) {
      if (args.json) { io.stdout.write(JSON.stringify({ channel, payload }) + '\n'); return; }
      const event = payload as Record<string, unknown>;
      if (channel === 'session:chunk' && typeof event.delta === 'string') { streamed += event.delta; io.stdout.write(event.delta); }
      if (channel === 'session:tool-call' && event.status === 'running') io.stderr.write('\n[工具] ' + event.toolName + '\n');
      if (channel === 'session:completed') {
        if (typeof event.output === 'string') {
          if (event.output.startsWith(streamed)) io.stdout.write(event.output.slice(streamed.length));
          else io.stdout.write('\n\n' + event.output);
        }
        io.stdout.write('\n');
      }
    },
    async confirm(request) {
      signal.throwIfAborted();
      if (args.yes) return true;
      if (!io.stdin.isTTY || !io.stderr.isTTY) { io.stderr.write('需要确认；非交互终端已拒绝。使用 --yes 可显式允许本次运行的确认请求。\n'); return false; }
      const terminal = createInterface({ input: io.stdin, output: io.stderr });
      const combined = request.signal ? AbortSignal.any([signal, request.signal]) : signal;
      try {
        const answer = await terminal.question('\n' + approvalDetails(request) + '\n允许？[y/N] ', { signal: combined });
        combined.throwIfAborted();
        return ['y', 'yes', '是', '允许'].includes(answer.trim().toLowerCase());
      } finally { terminal.close(); }
    },
  };
}
