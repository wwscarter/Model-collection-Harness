import { createHash } from 'node:crypto';

export interface SearchSymbol { name: string; kind: string; path: string; line: number; signature: string; endLine?: number; }
export interface SearchChunk { id: string; path: string; line: number; endLine: number; signature?: string; text: string; hash: string; }
export const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Prefer symbol boundaries and bound long declarations by lines and characters. */
export function chunkFile(filePath: string, text: string, symbols: SearchSymbol[] = []): SearchChunk[] {
  if (text.includes('\0')) return [];
  const lines = text.split(/\r?\n/);
  const candidates = symbols.filter((symbol) => symbol.path.replaceAll('\\', '/') === filePath && Number.isSafeInteger(symbol.line) && symbol.line > 0 && symbol.line <= lines.length).sort((a, b) => a.line - b.line);
  const ranges: Array<{ start: number; end: number; signature?: string }> = candidates.length ? candidates.map((symbol, index) => ({
    start: symbol.line, end: Math.min(lines.length, Math.max(symbol.line, symbol.endLine ?? (candidates[index + 1]?.line ?? lines.length + 1) - 1)), signature: symbol.signature,
  })) : [{ start: 1, end: lines.length, signature: undefined }];
  // Symbols improve boundaries, while the gaps retain imports, module constants
  // and initialization code that does not have a declaration in the symbol index.
  const gaps: typeof ranges = [];
  let uncovered = 1;
  for (const range of ranges) {
    if (range.start > uncovered) gaps.push({ start: uncovered, end: range.start - 1, signature: undefined });
    uncovered = Math.max(uncovered, range.end + 1);
  }
  if (uncovered <= lines.length) gaps.push({ start: uncovered, end: lines.length, signature: undefined });
  ranges.push(...gaps);
  const chunks: SearchChunk[] = [];
  for (const range of ranges) {
    for (let line = range.start; line <= range.end;) {
      let endLine = Math.min(range.end, line + 79);
      let content = lines.slice(line - 1, endLine).join('\n');
      while (content.length > 6_000 && endLine > line) { endLine -= 1; content = lines.slice(line - 1, endLine).join('\n'); }
      for (let offset = 0; offset < content.length; offset += 6_000) {
        const part = content.slice(offset, offset + 6_000);
        if (!part.trim()) continue;
        const hash = contentHash(part);
        chunks.push({ id: contentHash(filePath + ':' + line + ':' + endLine + ':' + offset), path: filePath, line, endLine, signature: range.signature, text: part, hash });
      }
      line = endLine + 1;
    }
  }
  return [...new Map(chunks.map((chunk) => [chunk.id, chunk])).values()];
}

export function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length || !left.length) return 0;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) { dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2; }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function reciprocalRankFusion(lexical: string[], semantic: string[], limit: number): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const ranking of [lexical, semantic]) for (const [index, id] of ranking.entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1));
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
