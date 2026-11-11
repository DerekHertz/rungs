import type { LineRange } from "./graph.ts";

/**
 * Line diff of two texts, from the lines `splitLines` gives. Everything the reviewer sees about
 * what changed is derived from it: it reads the base and head trees and nothing else.
 */

export type LineOp =
  | { readonly kind: "same"; readonly text: string; readonly base: number; readonly head: number }
  | { readonly kind: "added"; readonly text: string; readonly head: number }
  | { readonly kind: "removed"; readonly text: string; readonly base: number };

/** One line of a view: `line` is the head's line number, and a removed line has none. */
export interface Row {
  readonly kind: LineOp["kind"];
  readonly text: string;
  readonly line?: number;
}

/**
 * The most added plus removed lines the search tries to minimise. A bigger rewrite is shown as the
 * whole old middle removed and the whole new one added: still a correct diff, just not a minimal one.
 */
const MAX_EDITS = 2000;

/** A shortest edit script from `base` to `head` (Myers, "An O(ND) Difference Algorithm", 1986). */
export function diffLines(base: readonly string[], head: readonly string[]): LineOp[] {
  let top = 0;
  while (top < base.length && top < head.length && base[top] === head[top]) top++;
  let bottom = 0;
  while (bottom < base.length - top && bottom < head.length - top && base[base.length - 1 - bottom] === head[head.length - 1 - bottom]) bottom++;
  const a = base.slice(top, base.length - bottom);
  const b = head.slice(top, head.length - bottom);
  const steps = shortestEdit(a, b) ?? [...a.map(() => "removed" as const), ...b.map(() => "added" as const)];

  const ops: LineOp[] = [];
  let baseLine = 0;
  let headLine = 0;
  for (; baseLine < top; baseLine++, headLine++) ops.push({ kind: "same", text: base[baseLine]!, base: baseLine + 1, head: headLine + 1 });
  for (const step of steps) {
    if (step === "same") ops.push({ kind: "same", text: base[baseLine]!, base: ++baseLine, head: ++headLine });
    else if (step === "removed") ops.push({ kind: "removed", text: base[baseLine]!, base: ++baseLine });
    else ops.push({ kind: "added", text: head[headLine]!, head: ++headLine });
  }
  for (; baseLine < base.length; baseLine++, headLine++) ops.push({ kind: "same", text: base[baseLine]!, base: baseLine + 1, head: headLine + 1 });
  return ops;
}

type Step = LineOp["kind"];

/** The steps from `a` to `b`, removals before additions in a run, or undefined past MAX_EDITS. */
function shortestEdit(a: readonly string[], b: readonly string[]): Step[] | undefined {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map(() => "added");
  if (m === 0) return a.map(() => "removed");
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] is v as it stood before round d, kept only for the diagonals round d can read.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
  }
  return undefined;
}

function backtrack(trace: readonly Int32Array[], last: number, n: number, m: number): Step[] {
  const steps: Step[] = [];
  let x = n;
  let y = m;
  for (let d = last; d > 0; d--) {
    const before = trace[d]!;
    const at = (k: number): number => before[k + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > (down ? previousX : previousX + 1) && y > (down ? previousY + 1 : previousY)) {
      steps.push("same");
      x--;
      y--;
    }
    steps.push(down ? "added" : "removed");
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    steps.push("same");
    x--;
    y--;
  }
  return steps.reverse();
}

/**
 * The rows of a view of the head's lines `range` (all of them without one): its unchanged and added
 * lines, and the removed ones in place. A removed run sits between two head lines; it belongs to the
 * range when both are inside it, or when it ends right before the range's first line and that line
 * was added, which is how a changed first line reads.
 */
export function rowsInRange(ops: readonly LineOp[], range?: LineRange): Row[] {
  if (range === undefined) return ops.map(rowOf);
  const rows: Row[] = [];
  let above = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.kind === "removed") {
      let end = i;
      while (ops[end + 1]?.kind === "removed") end++;
      const next = ops[end + 1];
      const inside = above >= range.start && above < range.end;
      const replacesFirst = above === range.start - 1 && next?.kind === "added" && next.head === range.start;
      if (inside || replacesFirst) for (let j = i; j <= end; j++) rows.push(rowOf(ops[j]!));
      i = end;
      continue;
    }
    above = op.head;
    if (op.head >= range.start && op.head <= range.end) rows.push(rowOf(op));
  }
  return rows;
}

function rowOf(op: LineOp): Row {
  return op.kind === "removed" ? { kind: "removed", text: op.text } : { kind: op.kind, text: op.text, line: op.head };
}

export function changeCounts(rows: readonly Row[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "added") added++;
    else if (row.kind === "removed") removed++;
  }
  return { added, removed };
}
