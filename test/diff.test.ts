import { describe, expect, test } from "vitest";
import { changeCounts, diffLines, firstChange, rowsFromText, rowsInRange } from "../src/diff.ts";
import type { LineOp } from "../src/diff.ts";

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
    const ops = diffLines(lines("a b c"), lines("a b c"));
    expect(ops).toEqual([
      { kind: "same", text: "a", base: 1, head: 1 },
      { kind: "same", text: "b", base: 2, head: 2 },
      { kind: "same", text: "c", base: 3, head: 3 },
    ]);
  });

  test("an added line is numbered in the head", () => {
    const ops = diffLines(lines("a c"), lines("a b c"));
    expect(kinds(ops)).toBe("s:a a:b s:c");
    expect(ops[1]).toEqual({ kind: "added", text: "b", head: 2 });
    expect(ops[2]).toEqual({ kind: "same", text: "c", base: 2, head: 3 });
  });

  test("a removed line is numbered in the base", () => {
    const ops = diffLines(lines("a b c"), lines("a c"));
    expect(kinds(ops)).toBe("s:a r:b s:c");
    expect(ops[1]).toEqual({ kind: "removed", text: "b", base: 2 });
  });

  test("a changed line is the removed line then the added one", () => {
    expect(kinds(diffLines(lines("a b c"), lines("a x c")))).toBe("s:a r:b a:x s:c");
  });

  test("empty on either side", () => {
    expect(kinds(diffLines([], lines("a b")))).toBe("a:a a:b");
    expect(kinds(diffLines(lines("a b"), []))).toBe("r:a r:b");
    expect(diffLines([], [])).toEqual([]);
  });

  test("finds a shortest edit script where trimming the ends is not enough", () => {
    // base a b c a b b a, head c b a b a c: the classic Myers example, an edit distance of 5.
    const ops = diffLines(lines("a b c a b b a"), lines("c b a b a c"));
    expect(ops.filter((op) => op.kind !== "same")).toHaveLength(5);
    expect(replay(ops)).toEqual({ base: lines("a b c a b b a"), head: lines("c b a b a c") });
  });

  test("repeated lines pair in order", () => {
    expect(kinds(diffLines(lines("} } }"), lines("} }")))).toBe("s:} s:} r:}");
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
      const ops = diffLines(base, head);
      expect(replay(ops)).toEqual({ base, head });
      // numbering is dense on each side
      expect(ops.filter((op) => op.kind !== "removed").map((op) => (op as { head: number }).head)).toEqual(head.map((_, i) => i + 1));
      expect(ops.filter((op) => op.kind !== "added").map((op) => (op as { base: number }).base)).toEqual(base.map((_, i) => i + 1));
    }
  });

  test("a rewrite too large to search is one removed block then one added block, still replaying", () => {
    const base = Array.from({ length: 5000 }, (_, i) => `old${i}`);
    const head = Array.from({ length: 5000 }, (_, i) => `new${i}`);
    const ops = diffLines(base, head);
    expect(replay(ops)).toEqual({ base, head });
    expect(ops.slice(0, 5000).every((op) => op.kind === "removed")).toBe(true);
  });
});

describe("rowsInRange", () => {
  // head: 1 a, 2 B, 3 c, 4 d, 5 e   base: a b c x d e
  const ops = diffLines(lines("a b c x d e"), lines("a B c d e"));

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
    expect(rowsInRange(diffLines(lines("a c"), lines("a b c")), { start: 2, end: 2 })).toEqual([{ kind: "added", line: 2, text: "b" }]);
  });

  test("a file that lost every line is all removed rows", () => {
    expect(rowsInRange(diffLines(lines("a b"), [])).map((row) => row.kind)).toEqual(["removed", "removed"]);
  });
});

describe("changeCounts", () => {
  test("counts added and removed rows", () => {
    const rows = rowsInRange(diffLines(lines("a b c"), lines("a x y c d")));
    expect(changeCounts(rows)).toEqual({ added: 3, removed: 1 });
  });
});

describe("firstChange", () => {
  const rows = rowsInRange(diffLines(lines("a b c x d e"), lines("a B c d e")));

  test("is the index of the first added or removed row", () => {
    expect(firstChange(rows)).toBe(1);
  });

  test("inside a range it skips changes above it", () => {
    expect(firstChange(rows, { start: 3, end: 5 })).toBe(4);
  });

  test("a removed row counts for the line it sits before", () => {
    expect(firstChange(rows, { start: 4, end: 5 })).toBe(4);
    expect(firstChange(rows, { start: 5, end: 5 })).toBeUndefined();
  });

  test("is undefined when nothing changed", () => {
    expect(firstChange(rowsFromText("a\nb\n", 10))).toBeUndefined();
  });
});

describe("rowsFromText", () => {
  test("numbers unchanged rows from the first line, without the final newline's empty line", () => {
    expect(rowsFromText("x\n\ny\n", 7)).toEqual([
      { kind: "same", line: 7, text: "x" },
      { kind: "same", line: 8, text: "" },
      { kind: "same", line: 9, text: "y" },
    ]);
    expect(rowsFromText("", 1)).toEqual([]);
  });
});
