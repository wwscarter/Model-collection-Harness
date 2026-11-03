export type OutputBlock =
  | { type: 'text'; id: string; content: string }
  | { type: 'code'; id: string; language: string; content: string; complete: boolean };

/** Keeps an unfinished fenced block as code while the next response chunk arrives. */
export function splitOutputBlocks(content: string): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  const lines = content.split('\n');
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  let textStart = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].replace(/\r$/, '');
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) continue;

    const start = offsets[lineIndex];
    if (start > textStart) blocks.push({ type: 'text', id: 'text-' + textStart, content: content.slice(textStart, start) });
    const marker = opening[1][0];
    const markerLength = opening[1].length;
    const language = opening[2].trim().split(/\s+/)[0] || '';
    const bodyStart = Math.min(content.length, start + lines[lineIndex].length + 1);
    let closingIndex = lineIndex + 1;
    while (closingIndex < lines.length) {
      const candidate = lines[closingIndex].replace(/\r$/, '');
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(candidate);
      if (closing && closing[1][0] === marker && closing[1].length >= markerLength) break;
      closingIndex += 1;
    }
    const complete = closingIndex < lines.length;
    const bodyEnd = complete ? offsets[closingIndex] : content.length;
    blocks.push({ type: 'code', id: 'code-' + start, language, content: content.slice(bodyStart, bodyEnd), complete });
    if (!complete) return blocks;
    textStart = Math.min(content.length, offsets[closingIndex] + lines[closingIndex].length + 1);
    lineIndex = closingIndex;
  }
  if (textStart < content.length) blocks.push({ type: 'text', id: 'text-' + textStart, content: content.slice(textStart) });
  return blocks;
}
