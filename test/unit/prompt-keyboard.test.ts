import { describe, expect, it } from 'vitest';
import { shouldSubmitPromptKey } from '../../src/renderer/promptKeyboard';

describe('prompt keyboard handling', () => {
  it('submits on Enter outside text composition', () => {
    expect(shouldSubmitPromptKey({ key: 'Enter', shiftKey: false })).toBe(true);
  });

  it('leaves Enter to the input method while composing text', () => {
    expect(shouldSubmitPromptKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitPromptKey({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false);
  });

  it('does not submit when Shift+Enter requests a new line', () => {
    expect(shouldSubmitPromptKey({ key: 'Enter', shiftKey: true })).toBe(false);
  });
});
