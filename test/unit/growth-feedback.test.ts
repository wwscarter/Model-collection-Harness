import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GrowthEngine } from '../../src/core/growth/GrowthEngine';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('growth feedback dimensions', () => {
  it('does not count a later user rating as an incomplete task', () => {
    const engine = new GrowthEngine({ learningRate: 0.1 });
    engine.recordFeedback({ modelId: 'm', taskType: 'code', success: true, completed: true, qualityScore: 90, actualCost: 0.1, actualLatency: 100 });
    const rated = engine.recordFeedback({ modelId: 'm', taskType: 'code', userSatisfaction: 5 });
    expect(rated).toMatchObject({ successRate: 1, taskCompletionRate: 1, avgCost: 0.1, avgLatency: 100 });
    expect(rated.avgQualityScore).toBeCloseTo(91);
  });

  it('retains measured quality when a later feedback sample only supplies usage', () => {
    const engine = new GrowthEngine();
    engine.recordFeedback({ modelId: 'm', taskType: 'code', success: true, qualityScore: 90 });
    expect(engine.recordFeedback({ modelId: 'm', taskType: 'code', actualCost: 0.1 })).toMatchObject({
      successRate: 1, taskCompletionRate: 1, avgQualityScore: 90,
    });
  });

  it('keeps unknown completion neutral when the first feedback is a rating', () => {
    const engine = new GrowthEngine();
    expect(engine.recordFeedback({ modelId: 'm', taskType: 'general', userSatisfaction: 5 })).toMatchObject({
      successRate: 0.5, taskCompletionRate: 0.5, avgQualityScore: 100,
    });
  });

  it('ignores one invalid persisted profile while retaining valid learned feedback', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-growth-profiles-'));
    directories.push(directory);
    const file = path.join(directory, 'profiles.json');
    const profile = { modelId: 'healthy', taskType: 'code', sampleCount: 2, successRate: 1, taskCompletionRate: 1, avgCost: 0.1, avgLatency: 100, avgQualityScore: 90, lastUpdated: '2026-11-04T08:00:00Z' };
    fs.writeFileSync(file, JSON.stringify([{ ...profile, modelId: 'invalid', lastUpdated: 'unavailable' }, profile]));
    const engine = new GrowthEngine({ storagePath: file });
    expect(engine.getProfiles().map((item) => item.modelId)).toEqual(['healthy']);
    engine.recordFeedback({ modelId: 'healthy', taskType: 'code', success: true });
    expect(new GrowthEngine({ storagePath: file }).getProfile('healthy', 'code')!.sampleCount).toBe(3);
  });
});
