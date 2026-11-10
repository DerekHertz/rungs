/** One claim: an exact span of the description, `description.slice(start, end) === text`. */
export interface Claim {
  readonly index: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const BULLET = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+/;
const HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const FENCE = /^[ \t]{0,3}(?:```|~~~)/;
// A sentence ends at ., ! or ? (and closing marks), then whitespace, then not a lowercase letter.
const SENTENCE_END = /[.!?]["')\]`*_]*(?=\s+(?![\p{Ll}]))/gu;

interface Line {
  readonly text: string;
  readonly start: number;
}

/**
 * Splits a change description into claims, by rules and not by a model: each markdown bullet
 * (with its wrapped lines) is one claim, and each sentence of any other paragraph is one.
 * Headings, fenced code and spans without a letter or digit are not claims.
 */
export function splitClaims(description: string): Claim[] {
  const lines: Line[] = [];
  for (let start = 0; start < description.length; ) {
    const newline = description.indexOf("\n", start);
    const stop = newline === -1 ? description.length : newline;
    const end = description[stop - 1] === "\r" && newline !== -1 ? stop - 1 : stop;
    lines.push({ text: description.slice(start, end), start });
    start = stop + 1;
  }

  const spans: [number, number][] = [];
  let block: { start: number; end: number; bullet: boolean } | undefined;
  const close = (): void => {
    if (block === undefined) return;
    if (block.bullet) spans.push([block.start, block.end]);
    else spans.push(...sentences(description, block.start, block.end));
    block = undefined;
  };

  let fenced = false;
  for (const line of lines) {
    const end = line.start + line.text.length;
    if (FENCE.test(line.text)) {
      close();
      fenced = !fenced;
    } else if (fenced || HEADING.test(line.text) || line.text.trim() === "") {
      close();
    } else {
      const bullet = BULLET.exec(line.text);
      if (bullet !== null) {
        close();
        block = { start: line.start + bullet[0].length, end, bullet: true };
      } else if (block !== undefined) {
        block.end = end;
      } else {
        block = { start: line.start + (line.text.length - line.text.trimStart().length), end, bullet: false };
      }
    }
  }
  close();

  return spans
    .map(([start, end]) => trimmed(description, start, end))
    .filter(([start, end]) => /[\p{L}\p{N}]/u.test(description.slice(start, end)))
    .map(([start, end], index) => ({ index, text: description.slice(start, end), start, end }));
}

function trimmed(text: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return [start, end];
}

function sentences(text: string, start: number, end: number): [number, number][] {
  const body = text.slice(start, end);
  const spans: [number, number][] = [];
  let from = 0;
  for (const match of body.matchAll(SENTENCE_END)) {
    const to = match.index + match[0].length;
    spans.push([start + from, start + to]);
    from = to;
  }
  spans.push([start + from, end]);
  return spans;
}
