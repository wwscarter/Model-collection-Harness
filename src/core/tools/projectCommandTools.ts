import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ProjectProcessManager, type ProjectProcessSnapshot } from '../tty/ProjectProcessManager';
import type { ApprovalDecision } from '../security/ApprovalPolicy';

function result(snapshot: ProjectProcessSnapshot, policy?: ApprovalDecision) {
  const state = snapshot.running ? '运行中' : snapshot.timedOut ? '超时' : snapshot.cancelled ? '已取消' : snapshot.status === 'stopped' ? '已停止' : snapshot.status === 'completed' ? '已完成' : '失败';
  const lines = [
    `状态：${state}`, `进程 ID：${snapshot.processId}`, ...(snapshot.pid ? [`PID：${snapshot.pid}`] : []),
    `工作目录：${snapshot.cwd}`, `命令：${snapshot.command}`,
    ...(snapshot.running ? ['后台进程会继续运行，可使用 process_status 查询、stop_process 停止。'] : [`退出码：${snapshot.exitCode ?? '无'}${snapshot.signal ? `（${snapshot.signal}）` : ''}`]),
    ...(snapshot.error ? [`错误：${snapshot.error}`] : []),
    ...(snapshot.urls.length ? [`日志中出现的 URL（需确认服务已就绪）：\n${snapshot.urls.join('\n')}`] : []),
    snapshot.output ? `输出${snapshot.truncated ? '（仅保留最后 64 KiB）' : ''}：\n${snapshot.output}` : '输出：（无）',
  ];
  lines.push('命令沙箱：' + (snapshot.sandbox.enabled ? '已启用' : '不可用') + '；网络：' + snapshot.sandbox.network + (snapshot.sandbox.reason ? '；' + snapshot.sandbox.reason : ''));
  return { content: [{ type: 'text' as const, text: lines.join('\n') }], details: { ...snapshot, ...(policy ? { policy } : {}) }, isError: snapshot.status === 'failed' || snapshot.cancelled };
}

/** Callers must obtain native user approval before invoking mutating tools. */
export function createProjectCommandTools(projectRoot: string, manager: ProjectProcessManager, options: { commandPolicy?: (command: string) => ApprovalDecision; sessionId?: string } = {}): ToolDefinition[] {
  return [
    defineTool({
      name: 'run_command', label: '执行项目命令',
      description: 'Run a project shell command under the configured approval policy and OS sandbox when available. The result reports actual sandbox status. Use background=true for a web/dev server; it continues after this response and returns a processId for later status/stop. Check process_status and HTTP readiness before reporting a running service.',
      promptSnippet: 'Execute an approved project command or start a persistent development server',
      parameters: Type.Object({
        command: Type.String({ minLength: 1, maxLength: 8192, description: 'Command passed to the platform shell. Working directory is the selected project.' }),
        background: Type.Optional(Type.Boolean({ description: 'Keep a long-lived server running after the tool returns. Default false.' })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 120000, description: 'Foreground deadline (default 30000, maximum 120000 ms). In background mode, startup observation period (default 1000, maximum 10000 ms); a returned background process has no automatic lifetime timeout.' })),
      }),
      async execute(_id, params, signal) {
        const policy = options.commandPolicy?.(params.command);
        return result(await manager.run({ ...params, projectRoot, signal, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }), policy);
      },
    }),
    defineTool({
      name: 'process_status', label: '查询项目进程',
      description: 'Query the current running/exited state and bounded logs of a process previously started with run_command in this project. The processId remains valid across conversation turns.',
      promptSnippet: 'Inspect an existing project process and its latest output',
      parameters: Type.Object({ processId: Type.String({ minLength: 1, description: 'processId returned by run_command.' }) }),
      async execute(_id, params) { return result(manager.status(params.processId, projectRoot)); },
    }),
    defineTool({
      name: 'process_list', label: '列出项目进程',
      description: 'List processes started with run_command in this project, including running/idle state and recent output. Use this when a processId was lost between turns.',
      promptSnippet: 'List managed project processes and their recent logs',
      parameters: Type.Object({}),
      async execute() {
        const processes = manager.list(projectRoot);
        const lines = processes.length
          ? processes.map((process) => `- ${process.processId} · ${process.running ? '运行中' : process.status} · ${process.command.slice(0, 180)}${process.urls.length ? ` · ${process.urls[0]}` : ''}`)
          : ['当前没有由本工具启动的进程。'];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }], details: { processes } };
      },
    }),
    defineTool({
      name: 'stop_process', label: '停止项目进程',
      description: 'Stop a process previously started with run_command in this project, including its shell children. Returns the final state and output.',
      promptSnippet: 'Stop a managed project server or command',
      parameters: Type.Object({ processId: Type.String({ minLength: 1, description: 'processId returned by run_command.' }) }),
      async execute(_id, params) { return result(await manager.stop(params.processId, projectRoot)); },
    }),
  ] as ToolDefinition[];
}
