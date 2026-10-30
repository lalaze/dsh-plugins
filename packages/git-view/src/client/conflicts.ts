/** One `<<<<<<<` … `=======` … `>>>>>>>` block; line indexes are 0-based, and `ours` and `theirs` keep their line endings. */
export interface ConflictBlock { start: number; middle: number; end: number; ours: string; theirs: string; label: string }

/** Lines with their own terminators, so a resolution keeps CRLF files CRLF. */
export const linesOf = (text: string) => text ? text.split(/(?<=\n)/) : [];
/** Conflict blocks, including diff3 style, whose `|||||||` common-ancestor section belongs to neither side. */
export function parseConflicts(text: string): ConflictBlock[] {
  const lines = linesOf(text), blocks: ConflictBlock[] = [];
  let start = -1, base = -1, middle = -1;
  lines.forEach((line, index) => {
    if (line.startsWith('<<<<<<<')) { start = index; base = -1; middle = -1; }
    else if (start >= 0 && middle < 0 && base < 0 && line.startsWith('|||||||')) base = index;
    else if (start >= 0 && middle < 0 && line.startsWith('=======')) middle = index;
    else if (start >= 0 && middle >= 0 && line.startsWith('>>>>>>>')) {
      blocks.push({ start, middle, end: index, ours: lines.slice(start + 1, base >= 0 ? base : middle).join(''), theirs: lines.slice(middle + 1, index).join(''),
        label: line.slice(7).trim() || 'incoming' });
      start = -1;
    }
  });
  return blocks;
}
/** The text with one block replaced by the current change, the incoming change, or both in that order. */
export function resolveConflict(text: string, block: ConflictBlock, choice: 'ours' | 'theirs' | 'both'): string {
  const lines = linesOf(text), eol = text.includes('\r\n') ? '\r\n' : '\n';
  // A side that ended the file without a newline gains one before the side appended after it.
  const joined = choice === 'both' && block.ours && !block.ours.endsWith('\n') ? `${block.ours}${eol}${block.theirs}` : choice === 'both' ? block.ours + block.theirs : block[choice];
  return [...lines.slice(0, block.start), joined, ...lines.slice(block.end + 1)].join('');
}
