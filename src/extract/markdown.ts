import { parse, postprocess, preprocess } from "micromark";
import { countLines, lineRangeOf, lineStarts } from "../lines.ts";

/** One heading and the lines it covers, 1-based and inclusive. */
export interface Heading {
  /** The heading's text as written: trimmed, without an ATX heading's opening and closing hashes. */
  readonly text: string;
  /** 1 to 6. */
  readonly level: number;
  readonly start: number;
  /** The line before the next heading of the same or a higher level, or the file's last line. */
  readonly end: number;
}

/**
 * The headings of a Markdown file in source order, as CommonMark reads them (micromark's block
 * parser): ATX and setext headings, wherever a block can stand, so also in a block quote or a list
 * item. Not headings: a `#` line in fenced or indented code, or in an HTML block; a fence belongs
 * to its container and ends with it. micromark gives each heading's start offset, and the offset
 * becomes a line through lines.ts, the one place that decides where a line ends.
 */
export function markdownSections(text: string): Heading[] {
  // micromark ends a line at a lone "\r" too, which lines.ts does not: a blank of the same length keeps every offset.
  const source = text.replace(/\r(?!\n)/g, " ");
  const events = postprocess(parse().document().write(preprocess()(source, undefined, true)));
  // micromark drops one leading BOM before it counts offsets, and lines.ts counts it: that one goes back on below. A second is content.
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  const body = source.slice(bom);
  // The markers micromark emits for a container or for indentation, which are not heading text.
  const prefixes = new Set(["linePrefix", "blockQuotePrefix", "listItemIndent", "listItemPrefix"]);
  const skipped: [number, number][] = [];
  for (const [phase, token] of events) if (phase === "enter" && prefixes.has(token.type)) skipped.push([token.start.offset, token.end.offset]);
  const found: { text: string; level: number; offset: number }[] = [];
  let current: { text: string; level: number; offset: number } | undefined;
  for (const [phase, token, context] of events) {
    if (phase === "enter") {
      if (token.type === "atxHeading" || token.type === "setextHeading") current = { text: "", level: 0, offset: token.start.offset };
      // A setext heading's token starts at a link definition before it; its section starts at its text.
      else if (token.type === "setextHeadingText" && current !== undefined) current.offset = token.start.offset;
      continue;
    }
    if (current === undefined) continue;
    // Only the opening run of hashes is the level; a closing run is not.
    if (token.type === "atxHeadingSequence") current.level ||= token.end.offset - token.start.offset;
    else if (token.type === "atxHeadingText") current.text = context.sliceSerialize(token).trim();
    else if (token.type === "setextHeadingLineSequence") current.level = body[token.start.offset] === "=" ? 1 : 2;
    else if (token.type === "setextHeadingText") {
      // The text as written, less the tokens micromark gives to prefixes: a literal ">" or indentation inside the text stays.
      let raw = "";
      let at = token.start.offset;
      for (const [from, to] of skipped) {
        if (to <= at || from >= token.end.offset) continue;
        raw += body.slice(at, Math.max(from, at));
        at = Math.max(at, to);
      }
      raw += body.slice(at, token.end.offset);
      current.text = raw.split(/\r?\n/).map((line) => line.trim()).join(" ");
    } else if (token.type === "atxHeading" || token.type === "setextHeading") {
      found.push(current);
      current = undefined;
    }
  }
  const starts = lineStarts(text);
  const total = countLines(text);
  const lined = found.map((heading) => ({ text: heading.text, level: heading.level, start: lineRangeOf(starts, heading.offset + bom, heading.offset + bom + 1).start }));
  return lined.map((heading, index) => {
    const next = lined.slice(index + 1).find((other) => other.level <= heading.level);
    return { ...heading, end: next === undefined ? total : next.start - 1 };
  });
}
