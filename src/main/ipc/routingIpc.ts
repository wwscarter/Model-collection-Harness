import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hasUsableCredentials } from '@core/models/ModelConfig';
import { validateRoutingSettings } from '@core/routing/RoutingSettings';
import { DEFAULT_ROUTING_POLICY, validateRoutingPolicy, RoutingPolicyEngine } from '@core/routing/RoutingPolicy';
import type { RoutingLearningStore } from '@core/growth/RoutingLearningStore';
import { requireString } from '../paths';
import type { MainContext } from '../MainContext';
import { handle } from './register';

function saveRoutingRules(ctx: MainContext, text: string) {
  const { routingRulesPath, routingHistoryDir, router } = ctx;
  const policy = validateRoutingPolicy(JSON.parse(text));
  if (fs.existsSync(routingRulesPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(routingRulesPath, path.join(routingHistoryDir, `${stamp}-${randomUUID()}.json`));
  }
  const temporary = `${routingRulesPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, routingRulesPath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the original error */ }
    throw error;
  }
  ctx.routingPolicy = new RoutingPolicyEngine(router, policy);
  try {
    const snapshots = fs.readdirSync(routingHistoryDir).filter((name) => name.endsWith('.json')).sort().reverse();
    for (const stale of snapshots.slice(20)) fs.rmSync(path.join(routingHistoryDir, stale), { force: true });
  } catch (error) { console.warn('Routing history cleanup failed', error); }
  return { policy, diagnostics: [] as string[] };
}

export function register(ctx: MainContext): void {
  const { registry, routingService, routingLearning, routingRulesPath, routingHistoryDir } = ctx;
  handle('routing:status', () => routingService.getStatus());
  handle('routing:config:get', () => routingService.getConfiguration());
  handle('routing:config:set', (_event, input: unknown) => {
    const next = validateRoutingSettings(input);
    for (const id of [next.planning.mode === 'auto' ? next.planning.modelId : undefined, next.utilityModelId]) {
      if (!id) continue;
      const model = registry.getModel(id);
      if (!model?.enabled || !hasUsableCredentials(model)) throw new Error('指定的分工模型不可用，请选择已启用且有可用凭据的模型');
    }
    const saved = routingService.save(next);
    void routingService.warmup();
    return saved;
  });
  handle('routing:config:probe', (_event, input?: unknown) => routingService.probe(input));
  handle('routing:learning:get', (_event, runId: unknown) => routingLearning.getObservation(requireString(runId, '运行 ID', 200)));
  handle('routing:learning:correct', (_event, input: unknown) => routingLearning.correct(input as Parameters<RoutingLearningStore['correct']>[0]));
  handle('routing:learning:export', () => routingLearning.exportData());
  handle('routing:learning:clear', () => { routingLearning.clear(); return { success: true }; });
  handle('routing:rules:get', () => ({
    path: routingRulesPath,
    text: fs.existsSync(routingRulesPath) ? fs.readFileSync(routingRulesPath, 'utf8') : `${JSON.stringify(DEFAULT_ROUTING_POLICY, null, 2)}\n`,
  }));
  handle('routing:rules:set', (_event, text: unknown) => {
    if (typeof text !== 'string' || text.length > 100_000) throw new Error('路由规则内容无效');
    return saveRoutingRules(ctx, text);
  });
  handle('routing:rules:history', () => fs.readdirSync(routingHistoryDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 20)
    .map((name) => ({ name, savedAt: fs.statSync(path.join(routingHistoryDir, name)).mtime.toISOString() })));
  handle('routing:rules:restore', (_event, name: unknown) => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+\.json$/.test(name)) throw new Error('历史版本名称无效');
    const snapshot = path.join(routingHistoryDir, name);
    if (!fs.existsSync(snapshot)) throw new Error('历史版本不存在');
    const text = fs.readFileSync(snapshot, 'utf8');
    return { text, ...saveRoutingRules(ctx, text) };
  });
}
