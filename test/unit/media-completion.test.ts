import { describe, expect, it } from 'vitest';
import type { MediaJob } from '../../src/core/media/MediaTypes';
import { recordMediaToolOutcome, resolveMediaCompletion, type MediaDependencyFailure } from '../../src/core/agent/run/mediaCompletion';
import { limitedStop, limitMessage } from '../../src/core/agent/run/runHelpers';

const scope = { runId: 'root-run', sessionId: 'session' };
function job(id: string, status: MediaJob['status'], revision = 0, overrides: Partial<MediaJob> = {}): MediaJob {
  return { id, required: true, rootRunId: scope.runId, sessionId: scope.sessionId, artifactSlot: 'landing.hero', revision,
    operation: 'image.generate', request: { operation: 'image.generate', artifactSlot: 'landing.hero', revision, prompt: 'A skyline' },
    status, attempts: [], artifacts: [], createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:10.000Z', costStatus: 'unknown',
    ...(status === 'failed' ? { error: 'Generation rejected' } : status === 'unknown' ? { error: 'Submission result unknown' } : {}), ...overrides };
}
const outcome = (status: 'failed' | 'completed', details?: unknown) => ({ toolCallId: 'tool-call', toolName: 'request_media', status, details });

describe('required media completion and recovery', () => {
  it('uses current durable state for a failed job which later succeeds', () => {
    const failures: MediaDependencyFailure[] = [];
    recordMediaToolOutcome(failures, outcome('failed', { code: 'MEDIA_GENERATION_FAILED', error: 'Rejected', details: { jobId: 'job', required: true } }), { artifactSlot: 'landing.hero' });
    expect(resolveMediaCompletion([job('job', 'failed')], failures, scope).blocked).toBe(true);
    expect(resolveMediaCompletion([job('job', 'succeeded')], failures, scope)).toMatchObject({ blocked: false, failures: [] });
  });

  it('lets a later successful revision release older failed and unknown dependencies', () => {
    const old = job('old', 'unknown');
    expect(resolveMediaCompletion([old, job('new', 'succeeded', 1)], [], scope)).toMatchObject({ blocked: false, failures: [] });
    const pending = resolveMediaCompletion([job('old', 'succeeded'), job('new', 'submitting', 1)], [], scope);
    expect(pending.blocked).toBe(true);
    expect(pending.failures[0]).toMatchObject({ jobId: 'new', code: 'MEDIA_PENDING', revision: 1 });
    expect(pending.notice).toContain('尚未完整交付');
  });

  it('does not let old success hide the latest failed revision and scopes jobs by run and session', () => {
    const result = resolveMediaCompletion([job('older', 'succeeded'), job('latest', 'failed', 1), job('foreign', 'unknown', 2, { sessionId: 'another-session' }), job('other-run', 'unknown', 3, { rootRunId: 'another-run' })], [], scope);
    expect(result.jobs.map((item) => item.id)).toEqual(['older', 'latest']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].jobId).toBe('latest');
    expect(result.notice).toContain('Generation rejected');
  });

  it('records invalid calls without jobs and clears them after successful same-slot retry', () => {
    const failures: MediaDependencyFailure[] = [];
    recordMediaToolOutcome(failures, outcome('failed', { code: 'MEDIA_INVALID_REQUEST', error: 'Missing size', required: true }), { artifactSlot: 'landing.hero', revision: 0 });
    expect(resolveMediaCompletion([], failures, scope).blocked).toBe(true);
    recordMediaToolOutcome(failures, outcome('completed', { status: 'succeeded', jobId: 'retry' }), { artifactSlot: 'landing.hero', revision: 0 });
    expect(resolveMediaCompletion([job('retry', 'succeeded')], failures, scope)).toMatchObject({ blocked: false, failures: [] });
  });

  it('can recover a missing-event failure from a newer persisted successful revision', () => {
    const failures: MediaDependencyFailure[] = [{ toolName: 'request_media', artifactSlot: 'landing.hero', revision: 0, observedAt: Date.parse('2026-11-11T00:00:05Z'), code: 'MEDIA_INVALID_REQUEST', message: 'Invalid parameter', required: true }];
    expect(resolveMediaCompletion([job('new', 'succeeded', 1)], failures, scope).blocked).toBe(false);
  });

  it('keeps a new conflicting requirement blocked even if an older revision succeeded', () => {
    const failures: MediaDependencyFailure[] = [{ toolName: 'request_media', artifactSlot: 'landing.hero', revision: 0, jobId: 'old', observedAt: Date.parse('2026-11-11T00:00:20Z'), code: 'MEDIA_REQUEST_CONFLICT', message: 'Requirements changed', required: true }];
    expect(resolveMediaCompletion([job('old', 'succeeded')], failures, scope).blocked).toBe(true);
    recordMediaToolOutcome(failures, outcome('completed'), { artifactSlot: 'landing.hero', revision: 1 });
    expect(resolveMediaCompletion([job('old', 'succeeded'), job('new', 'succeeded', 1)], failures, scope).blocked).toBe(false);
  });

  it('clears a failed export only when the same path succeeds', () => {
    const failures: MediaDependencyFailure[] = [];
    recordMediaToolOutcome(failures, { toolCallId: 'export-1', toolName: 'materialize_asset', status: 'failed', details: { error: 'Target exists', required: true } }, { path: 'public/hero.png', assetId: 'asset' });
    recordMediaToolOutcome(failures, { toolCallId: 'export-2', toolName: 'materialize_asset', status: 'completed' }, { path: 'public/other.png', assetId: 'asset' });
    expect(resolveMediaCompletion([], failures, scope).blocked).toBe(true);
    recordMediaToolOutcome(failures, { toolCallId: 'export-3', toolName: 'materialize_asset', status: 'completed' }, { path: 'public/hero.png', assetId: 'asset' });
    expect(resolveMediaCompletion([], failures, scope).blocked).toBe(false);
  });

  it('does not block optional errors and identifies media incomplete as an incomplete stop', () => {
    expect(resolveMediaCompletion([], [{ code: 'OPTIONAL', message: 'Optional', required: false }], scope).blocked).toBe(false);
    expect(limitedStop('media_incomplete')).toBe(true);
    expect(limitMessage('media_incomplete')).toContain('尚未完整交付');
  });
});
