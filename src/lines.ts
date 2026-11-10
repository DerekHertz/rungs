import type { LineRange } from "./graph.ts";

// A line ends at "\n" and nowhere else: "\r" stays in the line's text, and U+2028 and U+2029 do
// not end a line, although the TypeScript compiler's line numbers say they do. File line counts,
// code node ranges and source slices all go through this module, so they cannot disagree.

/** The UTF-16 offset at which each line begins, one entry per line. */
export function lineStarts(text: string): number[] {
  if (text === "") return [];
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1 && i + 1 < text.length; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return starts;
}

export function countLines(text: string): number {
  return lineStarts(text).length;
}

/** The lines covering UTF-16 offsets [start, end), where end > start. */
export function lineRangeOf(starts: readonly number[], start: number, end: number): LineRange {
  return { start: lineAt(starts, start), end: lineAt(starts, end - 1) };
}

/** The text of lines range.start to range.end, without the final line's "\n". */
export function sliceLines(text: string, range: LineRange): string {
  const starts = lineStarts(text);
  const from = starts[range.start - 1] ?? text.length;
  const next = starts[range.end];
  const to = next === undefined ? (text.endsWith("\n") ? text.length - 1 : text.length) : next - 1;
  return text.slice(from, to);
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}
