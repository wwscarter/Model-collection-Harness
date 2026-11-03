import { describe, expect, it } from 'vitest';
import { errorMessage, relativeTime } from '../../src/renderer/format';

describe('renderer format helpers', () => {
  it('strips the Electron IPC error prefix', () => {
    expect(errorMessage(new Error("Error invoking remote method 'projects:open': Error: 项目记录不存在"))).toBe('项目记录不存在');
    expect(errorMessage(new Error('plain failure'))).toBe('plain failure');
    expect(errorMessage('text')).toBe('text');
  });

  it('formats relative session times', () => {
    const now = new Date(2026, 10, 3, 12, 0, 0);
    expect(relativeTime(new Date(2026, 10, 3, 11, 59, 30), now)).toBe('刚刚');
    expect(relativeTime(new Date(2026, 10, 3, 11, 15), now)).toBe('45 分钟前');
    expect(relativeTime(new Date(2026, 10, 3, 9, 0), now)).toBe('3 小时前');
    expect(relativeTime(new Date(2026, 10, 2, 23, 0), now)).toBe('2026/11/02');
  });
});
