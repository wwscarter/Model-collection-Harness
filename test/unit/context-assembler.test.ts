import { describe, expect, it } from 'vitest';
import { assembleContext, type ContextTurn } from '../../src/core/context/ContextAssembler';

function turn(index: number, role: 'user' | 'assistant' = index % 2 ? 'assistant' : 'user', length = 400): ContextTurn {
  return { role, content: `message-${index}-${'x'.repeat(length)}` };
}

describe('ContextAssembler', () => {
  it('keeps short histories unchanged', () => {
    const history = [turn(0, 'user', 20), turn(1, 'assistant', 20)];
    const result = assembleContext({ history, contextWindow: 8_000, maxOutputTokens: 1_000 });
    expect(result.history).toEqual(history);
    expect(result.compacted).toBe(false);
    expect(result.summary).toBeUndefined();
  });

  it('compacts older turns into a deterministic summary', () => {
    const history = Array.from({ length: 20 }, (_, index) => turn(index));
    const result = assembleContext({ history, contextWindow: 900, maxOutputTokens: 100, reserveTokens: 150, minRecentTurns: 2 });
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain('Earlier conversation summary');
    expect(result.summaryCovers).toBeGreaterThan(0);
    expect(result.history.length).toBeLessThan(history.length);
    expect(result.estimatedTokens).toBeLessThanOrEqual(900);
    expect(result.summaryHash).toHaveLength(64);
  });

  it('carries tool results into the summarised context', () => {
    const history = Array.from({ length: 18 }, (_, index) => turn(index));
    history[1] = { ...history[1], tools: [{ name: 'read', status: 'completed', label: 'src/a.ts' }, { name: 'run_command', status: 'failed', label: 'npm test' }] };
    const result = assembleContext({ history, contextWindow: 900, maxOutputTokens: 100, reserveTokens: 150 });
    expect(result.summary).toContain('read/completed');
    expect(result.summary).toContain('run_command/failed');
  });

  it('reuses a persisted summary when the covered prefix hash matches', () => {
    const history = Array.from({ length: 20 }, (_, index) => turn(index));
    const first = assembleContext({ history, contextWindow: 900, maxOutputTokens: 100, reserveTokens: 150 });
    const nextHistory = [...history, turn(20, 'user', 100)];
    const second = assembleContext({
      history: nextHistory,
      summary: first.summary,
      summaryCovers: first.summaryCovers,
      summaryHash: first.summaryHash,
      contextWindow: 900,
      maxOutputTokens: 100,
      reserveTokens: 150,
    });
    expect(second.summary).toContain(first.summary!.split('\n').slice(0, 2).join('\n'));
    expect(second.summaryCovers).toBeGreaterThanOrEqual(first.summaryCovers);
    expect(second.history.some((item) => item.content.includes('message-20'))).toBe(true);
  });

  it('ignores a stale summary when the covered prefix changed', () => {
    const history = Array.from({ length: 20 }, (_, index) => turn(index));
    const result = assembleContext({
      history,
      summary: 'STALE-SUMMARY-MARKER',
      summaryCovers: 10,
      summaryHash: '0'.repeat(64),
      contextWindow: 900,
      maxOutputTokens: 100,
      reserveTokens: 150,
    });
    expect(result.summary).not.toContain('STALE-SUMMARY-MARKER');
  });
});
