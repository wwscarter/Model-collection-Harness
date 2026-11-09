import path from 'node:path';
import type { VerifyCommand, VerifyMode } from './VerificationTypes';

function isTestPath(value: string, projectRoot: string): boolean {
  const relative = path.isAbsolute(value) ? path.relative(path.resolve(projectRoot), path.resolve(value)) : value;
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i.test(relative.replaceAll('\\', '/'));
}

/** The host previews exactly the commands the loop will execute after confirmation. */
export function selectVerifyCommands(commands: VerifyCommand[], mode: VerifyMode, projectRoot: string, changedFiles: string[]): VerifyCommand[] {
  if (mode === 'off') return [];
  const full = mode === 'full' || changedFiles.some((file) => isTestPath(file, projectRoot));
  return [...commands.filter((command) => command.phase === 'quick'), ...(full ? commands.filter((command) => command.phase === 'full') : [])];
}
