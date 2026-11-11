import { changeCounts, firstChange, rowsFromText } from "../diff.ts";
import type { Row } from "../diff.ts";
import type { LineRange, NodeId } from "../graph.ts";

/** A panel's two columns and the band laid over them. */
export interface CodeParts {
  readonly gutter: HTMLElement;
  readonly code: HTMLElement;
  readonly body: HTMLElement;
  readonly mark: HTMLElement;
}

/** The rows drawn in a panel; the code column's elements, one per row. */
export interface Drawn {
  readonly rows: readonly Row[];
  readonly cells: readonly HTMLElement[];
  /** The gutter's elements, one per row, in the same order. */
  readonly gutters: readonly HTMLElement[];
}

/**
 * The rows of a node's source: its changes when the server has them, else its source as served,
 * its first line numbered `first`. Undefined when the node has no source. Text from the reviewed
 * tree is only ever set as textContent.
 */
export async function loadRows(id: NodeId, first: number): Promise<Loaded | undefined> {
  const changes = await fetch(`/changes?id=${encodeURIComponent(id)}`);
  const found = changes.ok ? ((await changes.json()) as { rows: Row[]; tooLarge?: true }) : undefined;
  if (found !== undefined && found.tooLarge !== true) return { rows: found.rows, tooLarge: false };
  const source = await fetch(`/source?id=${encodeURIComponent(id)}`);
  return source.ok ? { rows: rowsFromText(await source.text(), first), tooLarge: found !== undefined } : undefined;
}

/** A node's rows; `tooLarge` when its changes could not be worked out, so the lines are shown plain. */
export interface Loaded {
  readonly rows: readonly Row[];
  readonly tooLarge: boolean;
}

/** "3 changed lines", "too large to diff", or undefined when no row changed. */
export function changeNote(rows: readonly Row[], tooLarge = false): string | undefined {
  if (tooLarge) return "too large to diff";
  const { added, removed } = changeCounts(rows);
  const total = added + removed;
  return total === 0 ? undefined : `${total} changed ${total === 1 ? "line" : "lines"}`;
}

const GUTTER_MARK = { same: "", added: "+", removed: "−" } as const;

/** Draws `rows` in the panel: an added line tinted and marked in the gutter, a removed one greyed in place. */
export function drawRows(parts: CodeParts, rows: readonly Row[]): Drawn {
  const cell = (kind: Row["kind"], text: string): HTMLElement => {
    const span = document.createElement("span");
    span.className = `row ${kind}`;
    span.textContent = text;
    return span;
  };
  // Appended through fragments: spreading 100k rows into replaceChildren overflows the call stack.
  const gutter = document.createDocumentFragment();
  const code = document.createDocumentFragment();
  const cells: HTMLElement[] = [];
  const gutters: HTMLElement[] = [];
  for (const row of rows) {
    const number = cell(row.kind, row.line === undefined ? GUTTER_MARK[row.kind] : `${row.line}`);
    gutters.push(number);
    gutter.append(number);
    const text = cell(row.kind, row.text);
    if (row.noEol === true) {
      const note = document.createElement("span");
      note.className = "eol-note";
      note.textContent = "  \u23CE no newline at end of file";
      text.append(note);
    }
    code.append(text);
    cells.push(text);
  }
  parts.gutter.replaceChildren(gutter);
  parts.code.replaceChildren(code);
  parts.body.scrollTop = parts.body.scrollLeft = 0;
  parts.mark.hidden = true;
  return { rows, cells, gutters };
}

/** A run of rows folded away behind one line; `open` shows them again. */
export interface Fold {
  readonly from: number;
  readonly to: number;
  readonly open: () => void;
}

/**
 * Folds every run of rows outside `openRanges` (head line numbers) behind one line, "N lines
 * collapsed", that a click opens. A removed row stays with the numbered row above it. Nothing is
 * folded when no range is given: with nothing to prefer, every line stays. Returns the folds.
 */
export function collapseRows(drawn: Drawn, openRanges: readonly LineRange[]): Fold[] {
  if (openRanges.length === 0) return [];
  const numberedOpen = drawn.rows.map((row) => row.line !== undefined && openRanges.some((range) => row.line! >= range.start && row.line! <= range.end));
  // A removed row has no line: it opens with the numbered row above or below it, so a replaced line stays whole.
  const total = drawn.rows.length;
  const aboveOpen: boolean[] = [];
  let seen = false;
  for (let index = 0; index < total; index++) {
    if (drawn.rows[index]!.line !== undefined) seen = numberedOpen[index]!;
    aboveOpen.push(seen);
  }
  const belowOpen: boolean[] = new Array<boolean>(total).fill(false);
  seen = false;
  for (let index = total - 1; index >= 0; index--) {
    if (drawn.rows[index]!.line !== undefined) seen = numberedOpen[index]!;
    belowOpen[index] = seen;
  }
  const kept = drawn.rows.map((row, index) => (row.line !== undefined ? numberedOpen[index]! : aboveOpen[index]! || belowOpen[index]!));
  const folds: Fold[] = [];
  for (let from = 0; from < kept.length; from++) {
    if (kept[from]) continue;
    let to = from;
    while (to + 1 < kept.length && !kept[to + 1]) to++;
    const hidden = [...drawn.cells.slice(from, to + 1), ...drawn.gutters.slice(from, to + 1)];
    const count = to - from + 1;
    const marker = (text: string): HTMLElement => {
      const span = document.createElement("span");
      span.className = "row fold";
      span.textContent = text;
      return span;
    };
    const codeMarker = marker(`▸ ${count} ${count === 1 ? "line" : "lines"} collapsed`);
    const gutterMarker = marker("⋯");
    codeMarker.setAttribute("role", "button");
    codeMarker.tabIndex = 0;
    for (const element of hidden) element.style.display = "none";
    drawn.cells[from]!.before(codeMarker);
    drawn.gutters[from]!.before(gutterMarker);
    let opened = false;
    const open = (): void => {
      if (opened) return;
      opened = true;
      codeMarker.remove();
      gutterMarker.remove();
      for (const element of hidden) element.style.display = "";
    };
    codeMarker.addEventListener("click", open);
    codeMarker.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open();
    });
    folds.push({ from, to, open });
    from = to;
  }
  return folds;
}

/** Opens the folds that hold a numbered row of `range`, so a mark on it has somewhere to land. */
export function revealRange(drawn: Drawn, folds: readonly Fold[], range: LineRange): void {
  drawn.rows.forEach((row, index) => {
    if (row.line === undefined || row.line < range.start || row.line > range.end) return;
    for (const fold of folds) if (index >= fold.from && index <= fold.to) fold.open();
  });
}

/**
 * Scrolls the first change inside `range` (the first change at all without one) into view. The
 * range is banded unless it is every line shown and something changed: then the changed lines
 * themselves are the mark. Hides the band without a range or when the range misses the lines.
 */
export function markRows(parts: CodeParts, drawn: Drawn, range: LineRange | undefined): void {
  const { body, mark } = parts;
  mark.hidden = true;
  const numbered = drawn.rows.flatMap((row, index) => (row.line === undefined ? [] : [{ line: row.line, index }]));
  const first = numbered[0];
  const last = numbered.at(-1);
  const changed = firstChange(drawn.rows, range);
  const scrollTo = (cell: HTMLElement | undefined): void => {
    if (cell !== undefined) body.scrollTop = Math.max(0, cell.offsetTop - body.clientHeight / 3);
  };
  if (first === undefined || last === undefined) return;
  if (range === undefined || range.end < first.line || range.start > last.line) {
    if (range === undefined) scrollTo(drawn.cells[changed ?? 0]);
    return;
  }
  const whole = range.start <= first.line && range.end >= last.line;
  if (whole && firstChange(drawn.rows) !== undefined) {
    scrollTo(drawn.cells[changed ?? 0]);
    return;
  }
  const top = numbered.find((entry) => entry.line >= range.start);
  const bottom = numbered.findLast((entry) => entry.line <= range.end);
  if (top === undefined || bottom === undefined) return;
  const from = drawn.cells[top.index]!;
  const to = drawn.cells[bottom.index]!;
  mark.style.top = `${from.offsetTop}px`;
  mark.style.height = `${to.offsetTop + to.offsetHeight - from.offsetTop}px`;
  mark.style.width = `${body.scrollWidth}px`;
  mark.hidden = false;
  scrollTo(drawn.cells[changed ?? top.index]);
}
