import type { FailureDiagnostic } from './VerificationTypes';

/** Keep the tail on UTF-8 boundaries; terminal colours do not belong in feedback. */
export function failureOutputTail(output: string, maxBytes = 4_096): string {
  const plain = String(output ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const bytes = Buffer.from(plain, 'utf8');
  return (bytes.length <= maxBytes ? plain : bytes.subarray(bytes.length - maxBytes).toString('utf8').replace(/^\uFFFD+/, '')).trim();
}

export function summarizeFailure(output: string): { tail: string; diagnostics: FailureDiagnostic[] } {
  const tail = failureOutputTail(output);
  const diagnostics: FailureDiagnostic[] = [];
  let previousError = '';
  const seen = new Set<string>();
  for (const row of tail.split(/\r?\n/)) {
    const line = row.trim();
    if (!line) continue;
    const python = line.match(/File ["']([^"']+)["'], line (\d+)/);
    const location = line.match(/^(?:\s*(?:-->|at)\s*)?(.+?\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|c|cc|cpp|h|hpp|vue|svelte))(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\)|:\[(\d+),(\d+)\])\s*:?(.*)$/i);
    let diagnostic: FailureDiagnostic | undefined;
    if (python) diagnostic = { file: python[1], line: Number(python[2]), message: previousError || line };
    else if (location) diagnostic = {
      file: location[1].trim(), line: Number(location[2] || location[4] || location[6]),
      column: Number(location[3] || location[5] || location[7]) || undefined,
      message: location[8].trim() || previousError || line,
    };
    else if (/\b(?:[A-Za-z_][\w.]*(?:Error|Exception)|error|failed|failure)\b|exception|traceback|assertion|错误|失败/i.test(line)) {
      previousError = line;
      diagnostic = { message: line };
    }
    if (!diagnostic) continue;
    diagnostic.message = diagnostic.message.slice(0, 600);
    const key = JSON.stringify(diagnostic);
    if (!seen.has(key)) { seen.add(key); diagnostics.push(diagnostic); }
    if (diagnostics.length >= 20) break;
  }
  if (!diagnostics.length && tail) diagnostics.push({ message: tail.split(/\r?\n/).at(-1)!.slice(0, 600) });
  return { tail, diagnostics };
}
