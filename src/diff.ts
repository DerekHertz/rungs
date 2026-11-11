import type { LineRange } from "./graph.ts";
import { splitLines } from "./lines.ts";

/**
 * Line diff of two texts, from the lines `splitLines` gives. Everything the reviewer sees about
 * what changed is derived from it: it reads the base and head trees and nothing else.
 */

export type LineOp =
  | { readonly kind: "same"; readonly text: string; readonly base: number; readonly head: number; readonly noEol?: true }
  | { readonly kind: "added"; readonly text: string; readonly head: number; readonly noEol?: true }
  | { readonly kind: "removed"; readonly text: string; readonly base: number; readonly noEol?: true };

/** One line of a view: `line` is the head's line number, and a removed line has none. */
export interface Row {
  readonly kind: LineOp["kind"];
  readonly text: string;
  readonly line?: number;
  /** True for a file's last line when nothing ends it. */
  readonly noEol?: true;
}

/**
 * The most added plus removed lines Myers' search tries to minimise in one stretch. Past it the
 * stretch is split at the lines that occur once on each side (patience diff) and each piece is
 * searched on its own.
 */
const MAX_EDITS = 2000;

/**
 * A shortest edit script from `base` to `head` (Myers, "An O(ND) Difference Algorithm", 1986),
 * split by patience anchors when it is too long to search whole. Undefined when the texts are too
 * large to diff: a diff never marks a line that is the same on both sides as changed.
 */
export function diffLines(base: readonly string[], head: readonly string[]): LineOp[] | undefined {
  const steps = stepsBetween(base, 0, base.length, head, 0, head.length);
  if (steps === undefined) return undefined;
  const ops: LineOp[] = [];
  let baseLine = 0;
  let headLine = 0;
  for (const step of steps) {
    if (step === "same") ops.push({ kind: "same", text: base[baseLine]!, base: ++baseLine, head: ++headLine });
    else if (step === "removed") ops.push({ kind: "removed", text: base[baseLine]!, base: ++baseLine });
    else ops.push({ kind: "added", text: head[headLine]!, head: ++headLine });
  }
  return ops;
}

/** The diff of two texts, a last line with no "\n" after it counting as different from one with it. */
export function diffText(base: string, head: string): LineOp[] | undefined {
  const eof = (text: string): boolean => text !== "" && !text.endsWith("\n");
  const baseLines = splitLines(base);
  const headLines = splitLines(head);
  const baseOpen = eof(base);
  const headOpen = eof(head);
  const MARK = "\u0000no newline at end of file";
  const key = (lines: string[], open: boolean): string[] => (open ? [...lines.slice(0, -1), lines.at(-1)! + MARK] : lines);
  const ops = diffLines(key(baseLines, baseOpen), key(headLines, headOpen));
  if (ops === undefined) return undefined;
  const clean = (text: string, open: boolean): { text: string; noEol?: true } => (open ? { text: text.slice(0, -MARK.length), noEol: true } : { text });
  return ops.map((op) => {
    if (op.kind === "removed") return { ...op, ...clean(op.text, baseOpen && op.base === baseLines.length) };
    if (op.kind === "added") return { ...op, ...clean(op.text, headOpen && op.head === headLines.length) };
    return { ...op, ...clean(op.text, headOpen && op.head === headLines.length) };
  });
}

function stepsBetween(a: readonly string[], aLo: number, aHi: number, b: readonly string[], bLo: number, bHi: number): Step[] | undefined {
  const steps: Step[] = [];
  let top = 0;
  while (aLo + top < aHi && bLo + top < bHi && a[aLo + top] === b[bLo + top]) top++;
  let bottom = 0;
  while (aHi - aLo - top - bottom > 0 && bHi - bLo - top - bottom > 0 && a[aHi - 1 - bottom] === b[bHi - 1 - bottom]) bottom++;
  for (let i = 0; i < top; i++) steps.push("same");
  const from = aLo + top;
  const to = aHi - bottom;
  const bFrom = bLo + top;
  const bTo = bHi - bottom;
  const middle = shortestEdit(a.slice(from, to), b.slice(bFrom, bTo));
  if (middle !== undefined) steps.push(...middle);
  else {
    const anchors = patienceAnchors(a, from, to, b, bFrom, bTo);
    if (anchors.length === 0) {
      const seen = new Set(a.slice(from, to));
      if (b.slice(bFrom, bTo).some((line) => seen.has(line))) return undefined;
      for (let i = from; i < to; i++) steps.push("removed");
      for (let i = bFrom; i < bTo; i++) steps.push("added");
    } else {
      let x = from;
      let y = bFrom;
      for (const [ai, bi] of anchors) {
        const gap = stepsBetween(a, x, ai, b, y, bi);
        if (gap === undefined) return undefined;
        for (const step of gap) steps.push(step);
        steps.push("same");
        x = ai + 1;
        y = bi + 1;
      }
      const rest = stepsBetween(a, x, to, b, y, bTo);
      if (rest === undefined) return undefined;
      for (const step of rest) steps.push(step);
    }
  }
  for (let i = 0; i < bottom; i++) steps.push("same");
  return steps;
}

/** Pairs of indexes of lines that occur exactly once in each side, in an order both sides share, as many as possible. */
function patienceAnchors(a: readonly string[], aLo: number, aHi: number, b: readonly string[], bLo: number, bHi: number): [number, number][] {
  const once = (lines: readonly string[], lo: number, hi: number): Map<string, number> => {
    const seen = new Map<string, number>();
    for (let i = lo; i < hi; i++) seen.set(lines[i]!, seen.has(lines[i]!) ? -1 : i);
    return seen;
  };
  const inA = once(a, aLo, aHi);
  const inB = once(b, bLo, bHi);
  const pairs: [number, number][] = [];
  for (const [line, ai] of inA) {
    const bi = inB.get(line);
    if (ai >= 0 && bi !== undefined && bi >= 0) pairs.push([ai, bi]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  // Longest increasing subsequence of the b indexes, by patience sorting.
  const tails: number[] = [];
  const back: number[] = new Array<number>(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < pairs[i]![1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) back[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const chain: [number, number][] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = back[i]!) chain.push(pairs[i]!);
  return chain.reverse();
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
 *
 * With `base`, the range the same module had in the base, a removed line belongs to the range when
 * its base line is inside that, wherever it sits among the head's lines; null says the module has
 * no base counterpart, so nothing removed is its own.
 */
export function rowsInRange(ops: readonly LineOp[], range?: LineRange, base?: LineRange | null): Row[] {
  if (range === undefined) return ops.map(rowOf);
  if (base !== undefined) {
    return ops.flatMap((op): Row[] => {
      if (op.kind === "removed") return base !== null && op.base >= base.start && op.base <= base.end ? [rowOf(op)] : [];
      return op.head >= range.start && op.head <= range.end ? [rowOf(op)] : [];
    });
  }
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
  const eol = op.noEol === true ? { noEol: true as const } : {};
  return op.kind === "removed" ? { kind: "removed", text: op.text, ...eol } : { kind: op.kind, text: op.text, line: op.head, ...eol };
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
