import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoutingLearningStore, type RoutingObservation } from '../../src/core/growth/RoutingLearningStore';

const directories: string[] = [];
function location(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-routing-learning-'));
  directories.push(directory);
  return path.join(directory, 'routing-learning.json');
}
function observation(runId = 'run-1', overrides: Partial<RoutingObservation> = {}): RoutingObservation {
  return { runId, sessionId: 'session-1', description: 'Review the API handler', classification: { taskType: 'code', complexity: 'medium', confidence: 0.8, rationale: 'API keywords', backend: 'ollama', model: 'router:small', promptVersion: 'v3', durationMs: 25 }, ...overrides };
}
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('RoutingLearningStore', () => {
  it('keeps unreviewed observations in memory and persists only explicit user corrections', () => {
    const file = location();
    const store = new RoutingLearningStore(file);
    store.observe(observation());
    expect(fs.existsSync(file)).toBe(false);
    expect(store.exportData()).toEqual({ version: 1, source: 'user-corrections', samples: [] });
    const sample = store.correct({ runId: 'run-1', taskType: 'review', complexity: 'high' });
    expect(sample).toMatchObject({ source: 'user-correction', expected: { taskType: 'review', complexity: 'high' }, prediction: { taskType: 'code', complexity: 'medium' }, description: 'Review the API handler' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).samples).toHaveLength(1);
    const reloaded = new RoutingLearningStore(file);
    expect(reloaded.getObservation('run-1')).toEqual({ correction: sample });
    expect(() => reloaded.correct({ runId: 'run-1', taskType: 'analysis', complexity: 'low' })).toThrow('观测已不存在');
  });

  it('updates a correction by run id while retaining its stable id', () => {
    const store = new RoutingLearningStore(location());
    store.observe(observation());
    const first = store.correct({ runId: 'run-1', taskType: 'review', complexity: 'high' });
    const updated = store.correct({ runId: 'run-1', taskType: 'analysis', complexity: 'low' });
    expect(updated.id).toBe(first.id);
    expect(store.exportData().samples).toEqual([updated]);
    expect(store.getObservation('run-1')).toMatchObject({ observation: { runId: 'run-1' }, correction: { expected: { taskType: 'analysis', complexity: 'low' } } });
  });

  it('preserves the actual backend and model version metadata in confirmed samples', () => {
    const store = new RoutingLearningStore(location());
    const metadata = { inputTruncated: true, exampleCount: 2, backendVersion: '0.40.14', modelDigest: 'sha256:model-digest' };
    store.observe(observation('run-1', { classification: { ...observation().classification, ...metadata } }));
    expect(store.correct({ runId: 'run-1', taskType: 'review', complexity: 'high' }).prediction).toMatchObject(metadata);
    expect(() => store.observe(observation('invalid', { classification: { ...observation().classification, exampleCount: -1 } }))).toThrow('示例数量');
    expect(() => store.observe(observation('invalid', { classification: { ...observation().classification, inputTruncated: 'yes' as never } }))).toThrow('截断标记');
  });

  it('bounds pending observations to 100 and snapshots caller data', () => {
    const file = location();
    const store = new RoutingLearningStore(file);
    for (let index = 0; index < 101; index += 1) store.observe(observation('run-' + index));
    expect(store.getObservation('run-0')).toBeUndefined();
    expect(store.getObservation('run-1')?.observation).toBeDefined();
    const input = observation('bounded', { description: 'x'.repeat(9000), priorContext: 'y'.repeat(2000) });
    store.observe(input);
    input.classification.taskType = 'creative';
    const saved = store.getObservation('bounded')!.observation!;
    expect(saved.description).toHaveLength(8000);
    expect(saved.priorContext).toHaveLength(1500);
    expect(saved.classification.taskType).toBe('code');
    saved.classification.taskType = 'general';
    expect(store.getObservation('bounded')?.observation?.classification.taskType).toBe('code');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('strictly validates correction labels and requires a current observation', () => {
    const store = new RoutingLearningStore(location());
    store.observe(observation());
    expect(() => store.correct({ runId: 'missing', taskType: 'review', complexity: 'low' })).toThrow('观测已不存在');
    expect(() => store.correct({ runId: 'run-1', taskType: 'invented' as never, complexity: 'low' })).toThrow('任务类型无效');
    expect(() => store.correct({ runId: 'run-1', taskType: 'review', complexity: 'urgent' as never })).toThrow('复杂度无效');
    expect(() => store.correct({ runId: 'run-1', taskType: 'review', complexity: 'low', source: 'automatic' } as never)).toThrow('未知字段');
    expect(() => store.observe(observation('invalid', { classification: { ...observation().classification, confidence: NaN } }))).toThrow('置信度');
    expect(() => store.observe(observation('invalid', { description: '' }))).toThrow('任务描述');
    expect(store.exportData().samples).toEqual([]);
  });

  it('retains committed memory and disk when atomic replacement fails', () => {
    const file = location();
    const store = new RoutingLearningStore(file);
    store.observe(observation());
    const saved = store.correct({ runId: 'run-1', taskType: 'review', complexity: 'high' });
    const oldFile = fs.readFileSync(file, 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk commit failed'); });
    expect(() => store.correct({ runId: 'run-1', taskType: 'creative', complexity: 'low' })).toThrow('disk commit failed');
    expect(store.exportData().samples).toEqual([saved]);
    expect(fs.readFileSync(file, 'utf8')).toBe(oldFile);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['routing-learning.json']);
    expect(() => store.clear()).toThrow('disk commit failed');
    expect(store.getObservation('run-1')?.observation).toBeDefined();
  });

  it('starts empty on a damaged file while preserving diagnostics and the original bytes', () => {
    const file = location();
    fs.writeFileSync(file, '{broken');
    const store = new RoutingLearningStore(file);
    store.observe(observation());
    expect(store.exportData().samples).toEqual([]);
    expect(store.getDiagnostics()).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    store.correct({ runId: 'run-1', taskType: 'review', complexity: 'high' });
    expect(store.getDiagnostics()).toEqual([]);
    expect(new RoutingLearningStore(file).exportData().samples).toHaveLength(1);
  });

  it('rejects persisted samples without an explicit user-correction source', () => {
    const file = location();
    fs.writeFileSync(file, JSON.stringify({ version: 1, source: 'user-corrections', samples: [{ ...observation(), id: '1', prediction: observation().classification, expected: { taskType: 'code', complexity: 'low' }, createdAt: new Date().toISOString(), source: 'automatic' }] }));
    const store = new RoutingLearningStore(file);
    expect(store.exportData().samples).toEqual([]);
    expect(store.getDiagnostics()[0]).toContain('来源无效');
  });

  it('keeps at most 500 explicit corrections on disk', () => {
    const file = location();
    const store = new RoutingLearningStore(file);
    for (let index = 0; index < 501; index += 1) {
      store.observe(observation('run-' + index));
      store.correct({ runId: 'run-' + index, taskType: 'review', complexity: 'low' });
    }
    const exported = store.exportData();
    expect(exported.samples).toHaveLength(500);
    expect(exported.samples[0].runId).toBe('run-1');
    expect(new RoutingLearningStore(file).exportData().samples).toHaveLength(500);
    exported.samples.length = 0;
    expect(store.exportData().samples).toHaveLength(500);
  });

  it('retrieves only relevant user-corrected examples with bounded prompt growth', () => {
    const store = new RoutingLearningStore(location());
    for (let index = 0; index < 5; index += 1) {
      store.observe(observation('run-' + index, { description: '检查接口审计 '.repeat(150) + index, priorContext: 'API validation '.repeat(100) }));
      store.correct({ runId: 'run-' + index, taskType: 'review', complexity: 'high' });
    }
    store.observe(observation('unconfirmed', { description: '检查接口审计新任务' }));
    const examples = store.getExamples({ type: 'general', description: '请检查接口审计' });
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(examples).length).toBeLessThanOrEqual(1800);
    for (const sample of examples) {
      expect(sample.description.length).toBeLessThanOrEqual(600);
      expect(sample.priorContext?.length ?? 0).toBeLessThanOrEqual(300);
      expect(sample).toMatchObject({ taskType: 'review', complexity: 'high' });
    }
    expect(store.getExamples({ type: 'general', description: 'Draw a spaceship' })).toEqual([]);
  });

  it('can use an exactly corrected request as an example without bypassing classification', () => {
    const store = new RoutingLearningStore(location());
    store.observe(observation());
    store.correct({ runId: 'run-1', taskType: 'review', complexity: 'high' });
    expect(store.getExamples({ type: 'general', description: 'Review the API handler' })).toEqual([{ description: 'Review the API handler', taskType: 'review', complexity: 'high' }]);
  });

  it('clears confirmed samples and pending observations together after a successful disk commit', () => {
    const file = location();
    const store = new RoutingLearningStore(file);
    store.observe(observation());
    store.correct({ runId: 'run-1', taskType: 'review', complexity: 'high' });
    store.clear();
    expect(store.getObservation('run-1')).toBeUndefined();
    expect(store.exportData().samples).toEqual([]);
    expect(new RoutingLearningStore(file).exportData().samples).toEqual([]);
  });
});
