import type { LineRange } from "../graph.ts";

/**
 * Bands the lines of `range` over `code`, whose first line is numbered `first`, and scrolls
 * `body` to them; hides the band without a range or when the range ends above the text.
 */
export function markRange(parts: { code: HTMLElement; body: HTMLElement; mark: HTMLElement }, first: number, range: LineRange | undefined): void {
  const { code, body, mark } = parts;
  if (range === undefined || range.end < first) {
    mark.hidden = true;
    return;
  }
  const style = getComputedStyle(code);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const top = Number.parseFloat(style.paddingTop) + (Math.max(range.start, first) - first) * lineHeight;
  mark.style.top = `${top}px`;
  mark.style.height = `${(range.end - Math.max(range.start, first) + 1) * lineHeight}px`;
  mark.style.width = `${body.scrollWidth}px`;
  mark.hidden = false;
  body.scrollTop = Math.max(0, top - body.clientHeight / 3);
}
