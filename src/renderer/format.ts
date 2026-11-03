/** Electron wraps errors thrown in ipcMain handlers; show only the original message. */
export function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, '');
}

/** Sidebar timestamps: 刚刚 / N 分钟前 / N 小时前 (same day) / YYYY/MM/DD. */
export function relativeTime(value: Date, now = new Date()): string {
  const diff = now.getTime() - value.getTime();
  if (!Number.isFinite(diff)) return '';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000 && now.getDate() === value.getDate()) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}/${pad(value.getMonth() + 1)}/${pad(value.getDate())}`;
}
