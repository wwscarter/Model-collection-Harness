import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectContext } from '../../src/core/project/ProjectContext';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-context-budget-'));
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'hello');
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('project context budgets', () => {
  it('includes file markers and truncation notices in every small budget', async () => {
    const context = new ProjectContext(directory);
    for (let budget = 0; budget <= 12; budget += 1) {
      const sync = context.buildContext(['notes.txt'], budget);
      const asyncResult = await context.buildContextAsync(['notes.txt'], budget);
      expect(asyncResult).toEqual(sync);
      expect(sync.tokenCount).toBeLessThanOrEqual(budget);
      expect(sync.text.length).toBeLessThanOrEqual(budget * 4);
    }
  });

  it('does not reserve a truncation notice when the complete file fits, or repeat selected files', async () => {
    const context = new ProjectContext(directory);
    const fullText = '--- FILE: notes.txt ---\nhello';
    const result = await context.buildContextAsync(['notes.txt', './notes.txt'], Math.ceil(fullText.length / 4));
    expect(result.text).toBe(fullText);
    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(result.skippedFiles).toBe(0);
  });
});
