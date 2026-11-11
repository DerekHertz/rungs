import { splitLines } from "../lines.ts";

/** One ATX heading and the lines it covers, 1-based and inclusive. */
export interface Heading {
  /** The heading's text as written: trimmed, without its opening and closing hashes. */
  readonly text: string;
  /** 1 to 6. */
  readonly level: number;
  readonly start: number;
  /** The line before the next heading of the same or a higher level, or the file's last line. */
  readonly end: number;
}

// Up to three spaces, one to six hashes, then a space, a tab or the end of the line.
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The ATX headings of a Markdown file in source order. A `#` line inside a fenced code block is
 * not one. Setext headings (underlined with = or -) are not read.
 */
export function markdownSections(text: string): Heading[] {
  const lines = splitLines(text);
  const found: { text: string; level: number; start: number }[] = [];
  let fence: { char: string; length: number } | undefined;
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    const open = FENCE.exec(line);
    if (fence !== undefined) {
      // A closing fence: the same character, at least as long, and nothing after it.
      if (open !== null && open[1]![0] === fence.char && open[1]!.length >= fence.length && open[2]!.trim() === "") fence = undefined;
      return;
    }
    // A backtick fence's info string has no backtick.
    if (open !== null && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      return;
    }
    const heading = ATX.exec(line);
    if (heading === null) return;
    // A closing run of hashes is not part of the text, but only when a space precedes it.
    const body = (heading[2] ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim();
    found.push({ text: body, level: heading[1]!.length, start: index + 1 });
  });
  return found.map((heading, index) => {
    const next = found.slice(index + 1).find((other) => other.level <= heading.level);
    return { ...heading, end: next === undefined ? lines.length : next.start - 1 };
  });
}
