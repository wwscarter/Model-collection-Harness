import { expect, it } from 'vitest';
import { ObservabilityEngine } from '@core/observability/ObservabilityEngine';

it('counts verified runs separately from skipped checks and replaces the outcome for one run', () => {
  const metrics = new ObservabilityEngine();
  try {
    const record = { attempts: 1, repairRounds: 0, durationMs: 100 };
    metrics.recordVerification({ ...record, runId: 'fixture-passed', status: 'passed' });
    metrics.recordVerification({ ...record, runId: 'fixture-failed', status: 'failed' });
    metrics.recordVerification({ ...record, runId: 'fixture-timeout', status: 'unverified' });
    expect(metrics.getSummary()).toMatchObject({ totalInvocations: 0, verificationCount: 2, verificationPassRate: 0.5, verificationUnverified: 1 });
    metrics.recordVerification({ ...record, attempts: 2, repairRounds: 1, runId: 'fixture-failed', status: 'passed' });
    expect(metrics.getSummary()).toMatchObject({ verificationCount: 2, verificationPassRate: 1, verificationUnverified: 1 });
    expect(metrics.getSummary({ from: new Date(Date.now() + 60_000) })).not.toHaveProperty('verificationCount');
  } finally { metrics.close(); }
});
