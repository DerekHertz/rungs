import { describe, expect, test } from "vitest";
import { changeCounts, diffLines, diffText, rowsInRange } from "../src/diff.ts";
import type { LineOp } from "../src/diff.ts";

const diff = (base: string[], head: string[]): LineOp[] => diffLines(base, head)!;

const lines = (text: string): string[] => (text === "" ? [] : text.split(" "));

const kinds = (ops: readonly LineOp[]): string => ops.map((op) => `${op.kind[0]}:${op.text}`).join(" ");

/** Replays the ops: the base is the same and removed lines, the head the same and added ones. */
function replay(ops: readonly LineOp[]): { base: string[]; head: string[] } {
  return {
    base: ops.filter((op) => op.kind !== "added").map((op) => op.text),
    head: ops.filter((op) => op.kind !== "removed").map((op) => op.text),
  };
}

describe("diffLines", () => {
  test("identical text is all unchanged, numbered on both sides", () => {
    const ops = diff(lines("a b c"), lines("a b c"));
    expect(ops).toEqual([
      { kind: "same", text: "a", base: 1, head: 1 },
      { kind: "same", text: "b", base: 2, head: 2 },
      { kind: "same", text: "c", base: 3, head: 3 },
    ]);
  });

  test("an added line is numbered in the head", () => {
    const ops = diff(lines("a c"), lines("a b c"));
    expect(kinds(ops)).toBe("s:a a:b s:c");
    expect(ops[1]).toEqual({ kind: "added", text: "b", head: 2 });
    expect(ops[2]).toEqual({ kind: "same", text: "c", base: 2, head: 3 });
  });

  test("a removed line is numbered in the base", () => {
    const ops = diff(lines("a b c"), lines("a c"));
    expect(kinds(ops)).toBe("s:a r:b s:c");
    expect(ops[1]).toEqual({ kind: "removed", text: "b", base: 2 });
  });

  test("a changed line is the removed line then the added one", () => {
    expect(kinds(diff(lines("a b c"), lines("a x c")))).toBe("s:a r:b a:x s:c");
  });

  test("empty on either side", () => {
    expect(kinds(diff([], lines("a b")))).toBe("a:a a:b");
    expect(kinds(diff(lines("a b"), []))).toBe("r:a r:b");
    expect(diff([], [])).toEqual([]);
  });

  test("finds a shortest edit script where trimming the ends is not enough", () => {
    // base a b c a b b a, head c b a b a c: the classic Myers example, an edit distance of 5.
    const ops = diff(lines("a b c a b b a"), lines("c b a b a c"));
    expect(ops.filter((op) => op.kind !== "same")).toHaveLength(5);
    expect(replay(ops)).toEqual({ base: lines("a b c a b b a"), head: lines("c b a b a c") });
  });

  test("repeated lines pair in order", () => {
    expect(kinds(diff(lines("} } }"), lines("} }")))).toBe("s:} s:} r:}");
  });

  test("replays to both sides over many seeded random edits", () => {
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: next(30) }, () => String.fromCharCode(97 + next(5)));
      const head = base.filter(() => next(4) !== 0);
      for (let edit = next(6); edit > 0; edit--) head.splice(next(head.length + 1), 0, String.fromCharCode(97 + next(5)));
      const ops = diff(base, head);
      expect(replay(ops)).toEqual({ base, head });
      // numbering is dense on each side
      expect(ops.filter((op) => op.kind !== "removed").map((op) => (op as { head: number }).head)).toEqual(head.map((_, i) => i + 1));
      expect(ops.filter((op) => op.kind !== "added").map((op) => (op as { base: number }).base)).toEqual(base.map((_, i) => i + 1));
    }
  });

  test("a rewrite with nothing in common is one removed block then one added block", () => {
    const base = Array.from({ length: 5000 }, (_, i) => `old${i}`);
    const head = Array.from({ length: 5000 }, (_, i) => `new${i}`);
    const ops = diff(base, head);
    expect(replay(ops)).toEqual({ base, head });
    expect(ops.slice(0, 5000).every((op) => op.kind === "removed")).toBe(true);
  });

  test("past the search budget, lines that match stay unchanged", () => {
    const base = Array.from({ length: 1001 }, (_, i) => [`old${i}`, `keep${i}`]).flat();
    const head = Array.from({ length: 1001 }, (_, i) => [`new${i}`, `keep${i}`]).flat();
    const ops = diff(base, head);
    expect(replay(ops)).toEqual({ base, head });
    expect(ops.filter((op) => op.kind === "same")).toHaveLength(1001);
    expect(changeCounts(rowsInRange(ops))).toEqual({ added: 1001, removed: 1001 });
  });

  test("is undefined, never a wrong mark, when matching lines cannot be placed", () => {
    const base = Array.from({ length: 6000 }, (_, i) => (i % 2 === 0 ? "x" : `a${i}`));
    const head = Array.from({ length: 6000 }, (_, i) => (i % 2 === 0 ? "x" : `b${i}`));
    expect(diffLines(base, head)).toBeUndefined();
  });
});

describe("diffText", () => {
  test("a 150k-line insertion or deletion diffs without overflowing the stack", () => {
    const big = "x\n".repeat(150000);
    expect(diffText("", big)).toHaveLength(150000);
    expect(diffText(big, "")).toHaveLength(150000);
    expect(diffText(big, `${big}y\n`)!.filter((op) => op.kind !== "same")).toHaveLength(1);
  });

  test("a final newline added or dropped is a change to the last line", () => {
    const added = diffText("a\nb", "a\nb\n")!;
    expect(added.filter((op) => op.kind !== "same").map((op) => `${op.kind[0]}:${op.text}`)).toEqual(["r:b", "a:b"]);
    expect(added.find((op) => op.kind === "removed")).toMatchObject({ noEol: true });
    expect(diffText("a\nb\n", "a\nb\n")!.every((op) => op.kind === "same")).toBe(true);
    expect(diffText("a\nb", "a\nb")!.every((op) => op.kind === "same")).toBe(true);
    expect(changeCounts(rowsInRange(diffText("a\nb\n", "a\nb")!))).toEqual({ added: 1, removed: 1 });
  });

  test("a changed last line that has no newline keeps its text", () => {
    expect(diffText("a\nb", "a\nc")!.map((op) => op.text)).toEqual(["a", "b", "c"]);
  });
});

describe("rowsInRange", () => {
  // head: 1 a, 2 B, 3 c, 4 d, 5 e   base: a b c x d e
  const ops = diff(lines("a b c x d e"), lines("a B c d e"));

  test("with no range every row is kept", () => {
    expect(rowsInRange(ops).map((row) => `${row.kind[0]}${row.line ?? "-"}:${row.text}`)).toEqual(["s1:a", "r-:b", "a2:B", "s3:c", "r-:x", "s4:d", "s5:e"]);
  });

  test("a removed line sits in place inside the range and has no line number", () => {
    const rows = rowsInRange(ops, { start: 2, end: 4 });
    expect(rows.map((row) => `${row.kind[0]}:${row.text}`)).toEqual(["r:b", "a:B", "s:c", "r:x", "s:d"]);
    expect(rows.find((row) => row.kind === "removed")?.line).toBeUndefined();
  });

  test("a removed line between two unchanged lines outside the range is left out", () => {
    expect(rowsInRange(ops, { start: 4, end: 5 }).map((row) => row.text)).toEqual(["d", "e"]);
  });

  test("a removed line at a range's top edge belongs to it only when the first line replaces it", () => {
    // x is removed right before d (line 4); d is unchanged, so x belongs to the lines above.
    expect(rowsInRange(ops, { start: 4, end: 5 })[0]!.text).toBe("d");
    // b is removed right before B (line 2), which replaces it, so a range starting at B shows it.
    expect(rowsInRange(ops, { start: 2, end: 3 })[0]).toMatchObject({ kind: "removed", text: "b" });
  });

  test("a range of one line that was added carries no removed rows", () => {
    expect(rowsInRange(diff(lines("a c"), lines("a b c")), { start: 2, end: 2 })).toEqual([{ kind: "added", line: 2, text: "b" }]);
  });

  test("removed lines belong to the function the base had them in, matched by base range, not by position", () => {
    // base: f is lines 1-3, g is 4-6; head folds each onto one line.
    const ops = diffText("function f() {\n  x();\n}\nfunction g() {\n  y();\n}\n", "function f() { x(); }\nfunction g() { y(); }\n")!;
    const f = rowsInRange(ops, { start: 1, end: 1 }, { start: 1, end: 3 });
    const g = rowsInRange(ops, { start: 2, end: 2 }, { start: 4, end: 6 });
    expect(f.map((row) => `${row.kind[0]}:${row.text}`)).toEqual(["r:function f() {", "r:  x();", "r:}", "a:function f() { x(); }"]);
    expect(g.map((row) => `${row.kind[0]}:${row.text}`)).toEqual(["r:function g() {", "r:  y();", "r:}", "a:function g() { y(); }"]);
  });

  test("a module with no base counterpart owns no removed line", () => {
    expect(rowsInRange(ops, { start: 2, end: 4 }, null).every((row) => row.kind !== "removed")).toBe(true);
  });

  test("a file that lost every line is all removed rows", () => {
    expect(rowsInRange(diff(lines("a b"), [])).map((row) => row.kind)).toEqual(["removed", "removed"]);
  });
});

describe("changeCounts", () => {
  test("counts added and removed rows", () => {
    const rows = rowsInRange(diff(lines("a b c"), lines("a x y c d")));
    expect(changeCounts(rows)).toEqual({ added: 3, removed: 1 });
  });
});
