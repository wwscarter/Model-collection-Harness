import { runCli } from './main';
import { runEval } from '../../eval/runner/runEval';

process.exitCode = await runCli(process.argv.slice(2), process, { eval: (args, signal) => runEval({ tasksDir: args.tasksDir, resultsDir: args.output, model: args.model, dataDir: args.dataDir, tags: args.tags, repeat: args.repeat, baseline: args.baseline, smoke: args.smoke, signal, onProgress: (event) => {
  if (args.json) process.stdout.write(JSON.stringify({ channel: 'eval:progress', payload: event }) + '\n');
  else process.stderr.write('[评测] ' + JSON.stringify(event) + '\n');
} }) });
