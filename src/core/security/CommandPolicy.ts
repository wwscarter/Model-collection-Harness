import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export type CommandCategory = 'read' | 'build' | 'write' | 'network' | 'escalate' | 'opaque';
export interface CommandAssessment { category: CommandCategory; outsideProject: boolean; reasons: string[] }
type ShellToken = string | { op?: string; pattern?: string; comment?: string };
const { parse } = createRequire(import.meta.url)('shell-quote') as { parse(source: string, env?: (name: string) => string): ShellToken[] };
const PRIORITY: Record<CommandCategory, number> = { read: 0, build: 1, write: 2, network: 3, opaque: 4, escalate: 5 };
const ADMIN = new Set(['sudo', 'su', 'doas', 'pkexec', 'shutdown', 'reboot', 'halt', 'poweroff', 'launchctl', 'systemctl', 'service', 'diskutil', 'mount', 'umount', 'mkfs', 'dd', 'fdisk', 'parted', 'kill', 'killall', 'pkill', 'runas', 'bcdedit', 'diskpart', 'format', 'sc', 'reg']);
const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet', 'ping', 'nc', 'ncat', 'socat', 'dig', 'nslookup', 'traceroute', 'http', 'https', 'httpie']);
const READ = new Set(['ls', 'cat', 'head', 'tail', 'pwd', 'wc', 'which', 'whereis', 'type', 'file', 'stat', 'du', 'df', 'tree', 'rg', 'grep', 'cut', 'sort', 'uniq', 'diff', 'cmp', 'echo', 'printf', 'true', 'false', 'test', '[', 'whoami', 'id', 'uname', 'date', 'basename', 'dirname', 'realpath', 'readlink', 'nl', 'od', 'xxd']);
const WRITE = new Set(['touch', 'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'chmod', 'chown', 'chgrp', 'install', 'ln', 'truncate', 'tee', 'rename']);
const BUILD = new Set(['make', 'gmake', 'cmake', 'ninja', 'mvn', 'mvnw', 'gradle', 'gradlew', 'pytest', 'pytest-3', 'ruff', 'mypy', 'tsc', 'vitest', 'jest', 'eslint', 'prettier', 'vite', 'webpack', 'rollup', 'esbuild', 'swift', 'dotnet']);
const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3', 'python2', 'ruby', 'perl', 'php', 'lua', 'bash', 'sh', 'zsh', 'dash', 'fish', 'powershell', 'pwsh', 'cmd']);
const SAFE_ENV = new Set(['NODE_ENV', 'CI', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'FORCE_COLOR', 'NO_COLOR', 'PYTHONUNBUFFERED']);
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'stdbuf']);
const basename = (value: string): string => path.posix.basename(value.replaceAll('\\', '/')).replace(/\.exe$/i, '').toLowerCase();
const assignment = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);

/** Resolve existing ancestors for prospective outputs without requiring them to exist. */
function canonical(target: string): string | undefined {
  let current = path.resolve(target);
  const suffix: string[] = [];
  for (let depth = 0; depth < 64; depth++) {
    try { return path.join(fs.realpathSync(current), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      suffix.push(path.basename(current)); current = parent;
    }
  }
  return undefined;
}

/** Preserve quoting while separating physical shell lines and discarding comments. */
function syntax(source: string): { source: string; dynamic: boolean; malformed: boolean } {
  let quote = ''; let escaped = false; let comment = false; let dynamic = false; let normalized = '';
  for (let index = 0; index < source.length; index++) {
    let char = source[index];
    if (!quote && char === '\r' && source[index + 1] === '\n') { char = '\n'; index++; }
    if (comment) {
      if (char === '\n' || char === '\r') { comment = false; normalized += ';'; }
      continue;
    }
    if (escaped) { normalized = char === '\n' ? normalized.slice(0, -1) : normalized + char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { normalized += char; escaped = true; continue; }
    if ((char === "'" || char === '"') && (!quote || quote === char)) { quote = quote ? '' : char; normalized += char; continue; }
    if (!quote && char === '#' && (index === 0 || /[\s;&|()<>]/.test(source[index - 1]))) { comment = true; continue; }
    if (quote !== "'" && (char === '$' || char.charCodeAt(0) === 96)) dynamic = true;
    normalized += !quote && (char === '\n' || char === '\r') ? ';' : char;
  }
  return { source: normalized, dynamic, malformed: Boolean(quote || escaped) };
}

/** A conservative classifier supplements the OS sandbox; it never executes shell text. */
export function classifyCommand(command: string, projectRoot?: string, workingDirectory?: string): CommandAssessment {
  const result: CommandAssessment = { category: 'read', outsideProject: false, reasons: [] };
  const add = (category: CommandCategory, reason: string) => {
    if (PRIORITY[category] > PRIORITY[result.category]) result.category = category;
    if (!result.reasons.includes(reason) && result.reasons.length < 20) result.reasons.push(reason);
  };
  if (typeof command !== 'string' || !command.trim() || command.length > 32_768) return { category: 'opaque', outsideProject: false, reasons: ['命令为空或超过分类长度上限'] };
  const root = projectRoot ? canonical(projectRoot) : undefined;
  let cwd = workingDirectory ? canonical(workingDirectory) : root;
  const outside = (value: string): boolean => {
    if (value === '/dev/null' || (process.platform === 'win32' && value.toUpperCase() === 'NUL')) return false;
    if (!root || !cwd || /^[~$%]/.test(value)) return true;
    const target = canonical(path.resolve(cwd, value));
    if (!target) return true;
    const relative = path.relative(root, target);
    return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  };
  const writes = (targets: string[]) => {
    if (!targets.length || targets.some(outside)) result.outsideProject = true;
    add('write', result.outsideProject ? '写入目标可能位于项目外' : '写入目标位于项目内');
  };
  const parsed = syntax(command);
  if (parsed.dynamic || parsed.malformed) add('opaque', parsed.malformed ? '命令引号或转义不完整' : '包含动态展开或命令构造');
  let tokens: ShellToken[];
  try { tokens = parse(parsed.source, (name) => '$' + name); }
  catch { add('opaque', '无法完整解析 shell 命令'); return result; }
  let segment: string[] = [];
  let directoryChanged = false;

  const classifySegment = () => {
    const words = segment; segment = [];
    let opaquePrefix = false;
    const consumeAssignments = () => {
      while (words.length && assignment(words[0])) {
        const name = words.shift()!.split('=', 1)[0];
        if (!SAFE_ENV.has(name)) opaquePrefix = true;
      }
    };
    consumeAssignments();
    while (words.length && WRAPPERS.has(basename(words[0]))) {
      const wrapper = basename(words.shift()!);
      if (wrapper === 'command' && words.some((word) => word === '-v' || word === '-V')) { add('read', '查询命令位置'); return; }
      while (words[0]?.startsWith('-')) {
        const option = words.shift()!;
        if (option === '--') break;
        if (['-u', '--unset', '-n', '--adjustment', '-o', '-e', '-i'].includes(option) && !(wrapper === 'env' && option === '-i')) words.shift();
        else if (wrapper === 'exec' && option === '-a') words.shift();
        else if (option === '-C' || option === '--chdir') {
          const directory = words.shift();
          if (directory) { if (outside(directory)) result.outsideProject = true; cwd = cwd ? canonical(path.resolve(cwd, directory)) : undefined; }
          else opaquePrefix = true;
        } else if (!['-i', '--ignore-environment', '-p', '-0', '--null'].includes(option) && !/^-[oei].+/.test(option)) opaquePrefix = true;
      }
      consumeAssignments();
    }
    if (opaquePrefix) add('opaque', '环境或包装器参数会改变命令语义');
    if (!words.length) { if (!result.reasons.length) add('opaque', '未发现可分类的执行程序'); return; }
    while (words[0] === '{' || words[0] === '}') { words.shift(); add('opaque', '包含 shell 分组'); }
    if (!words.length) return;
    const executable = words.shift()!;
    const program = basename(executable);
    const args = words;
    if (ADMIN.has(program) || program.startsWith('mkfs.')) { add('escalate', '行政或系统级程序：' + program); return; }
    if (/[\\/]/.test(executable) && !['/bin', '/usr/bin', '/sbin', '/usr/sbin', '/usr/local/bin', '/opt/homebrew/bin'].includes(path.dirname(executable)) && !['gradlew', 'mvnw'].includes(program)) add('opaque', '显式程序路径需要人工确认');
    if (program === 'cd') {
      directoryChanged = true;
      if (args.length !== 1 || args[0].startsWith('-') || /^[~$%]/.test(args[0])) { cwd = undefined; add('opaque', '工作目录变更无法静态确定'); }
      else { if (outside(args[0])) result.outsideProject = true; cwd = cwd ? canonical(path.resolve(cwd, args[0])) : undefined; add('read', '变更命令工作目录'); }
      return;
    }
    if (NETWORK.has(program)) { add('network', '访问网络的程序：' + program); return; }
    if (['eval', 'source', '.', 'xargs', 'base64', 'awk', 'sed', 'osascript'].includes(program)) { add('opaque', '解释、装载或转换命令：' + program); return; }
    if (program === 'git') {
      if (args.some((arg) => arg === '-c' || arg.startsWith('--config-env') || arg.startsWith('--exec-path'))) { add('opaque', 'Git 执行配置需要确认'); return; }
      const gitArgs = [...args];
      while (gitArgs[0]?.startsWith('-')) {
        const option = gitArgs.shift()!;
        if (['-C', '--git-dir', '--work-tree'].includes(option)) {
          const directory = gitArgs.shift();
          if (!directory || outside(directory)) result.outsideProject = true;
        } else if (!['--no-pager', '--paginate', '--literal-pathspecs', '--no-optional-locks', '--version', '--help'].includes(option)) add('opaque', 'Git 全局参数需要确认');
      }
      const operation = gitArgs[0];
      if (['push', 'pull', 'fetch', 'clone', 'ls-remote'].includes(operation ?? '')) { add('network', 'Git 网络操作'); return; }
      if (!operation || ['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'help', 'version'].includes(operation)) {
        const output = args.findIndex((arg) => arg === '--output');
        const outputValue = args.find((arg) => arg.startsWith('--output='));
        if (output >= 0 || outputValue) writes([outputValue?.slice(9) ?? args[output + 1] ?? '']);
        else add('read', 'Git 只读查询');
        return;
      }
      if (['branch', 'tag', 'remote', 'config'].includes(operation)) {
        const operands = args.slice(args.indexOf(operation) + 1);
        if (!operands.length || operands.some((arg) => ['--list', '-l', '--show-current', '--get', '--get-all', '--get-regexp'].includes(arg))) { add('read', 'Git 元数据查询'); return; }
      }
      if (['add', 'commit', 'init', 'branch', 'tag', 'remote', 'config', 'restore', 'checkout', 'switch', 'reset', 'merge', 'rebase', 'cherry-pick', 'revert', 'stash', 'clean', 'rm', 'mv', 'worktree', 'apply'].includes(operation)) {
        const targets = args.filter((arg) => !arg.startsWith('-') && arg !== operation);
        if (args.includes('--global') || args.includes('--system')) result.outsideProject = true;
        writes(targets.length ? targets : ['.']); return;
      }
      add('opaque', '未识别的 Git 子命令'); return;
    }
    if (program === 'find') {
      if (args.some((arg) => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg))) add('opaque', '文件查找包含后续程序');
      else if (args.some((arg) => ['-delete', '-fprint', '-fprint0', '-fprintf'].includes(arg))) writes(args.filter((arg) => !arg.startsWith('-')));
      else add('read', '只读文件查找');
      return;
    }
    if (WRITE.has(program)) {
      if (args.length && args.every((arg) => ['--help', '--version', '-h', '-V'].includes(arg))) { add('read', '查询程序帮助或版本'); return; }
      const targets = args.filter((arg) => !arg.startsWith('-'));
      if (program === 'cp' || program === 'install') {
        const directory = args.findIndex((arg) => arg === '-t' || arg === '--target-directory');
        const explicit = args.find((arg) => arg.startsWith('--target-directory='));
        writes([explicit?.slice(19) ?? (directory >= 0 ? args[directory + 1] : targets.at(-1)) ?? '']);
      } else writes(targets);
      return;
    }
    if (INTERPRETERS.has(program)) {
      if (args.some((arg) => /^(?:-[cepr]|--eval(?:=|$)|--print(?:=|$)|-command$|-encodedcommand$|\/c$)/i.test(arg))) add('opaque', '解释器内联程序需要确认');
      else if (args.length && args.every((arg) => ['--version', '--help', '-V', '-h', '-v'].includes(arg))) add('read', '查询解释器帮助或版本');
      else if (['node', 'nodejs', 'python', 'python2', 'python3'].includes(program) && args.length && (!args[0].startsWith('-') || (['node', 'nodejs'].includes(program) && ['--check', '--test'].includes(args[0])) || (args[0] === '-m' && ['pytest', 'unittest', 'compileall', 'py_compile', 'ruff', 'mypy', 'http.server'].includes(args[1])))) add('build', '执行项目脚本或检查模块');
      else add('opaque', '解释器执行方式无法静态确定');
      return;
    }
    if (['npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'go'].includes(program)) {
      if (['npm', 'pnpm', 'yarn', 'bun', 'npx'].includes(program) && args.some((arg) => ['--eval', '-e', '--print'].includes(arg))) { add('opaque', '构建程序包含内联代码'); return; }
      const operation = args.find((arg) => !arg.startsWith('-'));
      if (['publish', 'login', 'logout', 'whoami', 'ping', 'info', 'view'].includes(operation ?? '')) add('network', '包管理器网络操作');
      else if (args.length && args.every((arg) => ['--version', '--help', '-v', '-h', 'version'].includes(arg))) add('read', '查询构建程序版本');
      else if (operation === 'config' || (program === 'go' && operation === 'env')) {
        if (args.some((arg) => ['set', 'delete', '-w', '-u'].includes(arg))) { result.outsideProject ||= !args.includes('--location=project'); writes(['.']); }
        else add('read', '查询构建配置');
      } else if (program === 'npx' && (!operation || !BUILD.has(operation.split('@')[0]))) add('opaque', '未确认的包执行入口');
      else if (['run', 'run-script', 'exec', 'test', 't', 'build', 'check', 'lint', 'typecheck', 'start', 'dev', 'install', 'i', 'ci', 'add', 'remove', 'uninstall', 'update', 'upgrade', 'rebuild', 'audit', 'outdated', 'list', 'ls', 'why', 'pack', 'prune', 'dedupe', 'fmt', 'clippy', 'bench', 'doc', 'fetch', 'generate', 'vet', 'get', 'mod', 'clean'].includes(operation ?? '') || program === 'npx') add('build', '构建、依赖或项目脚本：' + program);
      else add('opaque', '未识别的构建子命令');
      return;
    }
    if (BUILD.has(program)) { add('build', '项目构建或检查：' + program); return; }
    if (READ.has(program)) {
      const output = program === 'sort' ? args.findIndex((arg) => arg === '-o' || arg === '--output') : -1;
      const outputValue = program === 'sort' ? args.find((arg) => arg.startsWith('--output=')) : undefined;
      if (program === 'date' && args.some((arg) => arg === '-s' || arg === '--set' || arg.startsWith('--set='))) add('escalate', '修改系统时间需要确认');
      else if (output >= 0 || outputValue) writes([outputValue?.slice(9) ?? args[output + 1] ?? '']);
      else if (args.some((arg) => arg === '--pre' || arg.startsWith('--pre='))) add('opaque', '检索程序包含预处理程序');
      else add('read', '只读或无副作用程序：' + program);
      return;
    }
    add('opaque', '未识别的程序：' + program);
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (typeof token === 'string') { segment.push(token); continue; }
    if (token.comment !== undefined) continue;
    if (token.op === 'glob' && token.pattern) { segment.push(token.pattern); continue; }
    const operator = token.op ?? '';
    if (['>', '>>', '>|', '&>', '>&', '<', '<&', '<<', '<<<'].includes(operator)) {
      const target = tokens[++index];
      if (operator === '<<' || operator === '<<<') add('opaque', '包含内联输入或文档');
      else if (operator.includes('>')) {
        if ((operator === '>&') && typeof target === 'string' && /^\d+$/.test(target)) continue;
        if (typeof target === 'string' && target !== '/dev/null') writes([target]);
        else if (typeof target !== 'string') { result.outsideProject = true; add('opaque', '无法确定输出目标'); }
      }
      continue;
    }
    classifySegment();
    if (directoryChanged && ['|', '|&', '&', '||'].includes(operator)) { cwd = undefined; add('opaque', '控制流中的工作目录无法静态确定'); }
    if (![';', '&&', '||', '|', '|&', '&'].includes(operator)) add('opaque', '包含复杂 shell 控制结构');
  }
  classifySegment();
  if (!result.reasons.length) add('opaque', '未发现可分类的执行程序');
  return result;
}
