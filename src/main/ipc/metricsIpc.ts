import type { RoutingFeedback } from '@core/growth/GrowthEngine';
import type { MainContext } from '../MainContext';
import { handle } from './register';

function resolveMetricsRange(options?: { range?: '24h' | '7d' | '30d'; from?: string; to?: string }) {
  if (options?.from || options?.to) return { from: options.from, to: options.to };
  const to = new Date();
  const hours = options?.range === '24h' ? 24 : options?.range === '30d' ? 30 * 24 : 7 * 24;
  return { from: new Date(to.getTime() - hours * 60 * 60 * 1000), to };
}

export function register(ctx: MainContext): void {
  const { observability, auditLog, growth, operationAudit } = ctx;
  handle('metrics:task', (_event, taskId: string) => observability.getTaskMetrics(taskId));
  handle('metrics:recent', (_event, limit?: number) => observability.getRecent(limit));
  handle('metrics:dashboard', (_event, options?: { range?: '24h' | '7d' | '30d'; from?: string; to?: string }) => observability.getDashboardSnapshot(resolveMetricsRange(options)));
  handle('metrics:report', (_event, options?: { range?: '24h' | '7d' | '30d'; from?: string; to?: string }) => observability.getReportMarkdown(resolveMetricsRange(options)));
  handle('audit:verify', () => auditLog.verify());
  handle('audit:operations', (_event, limit?: unknown) => {
    const size = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.floor(limit)) : 100;
    return operationAudit?.read(size) ?? [];
  });
  handle('growth:profiles', () => growth.getProfiles());
  handle('growth:feedback', (_event, feedback: RoutingFeedback) => growth.recordFeedback(feedback));
}
