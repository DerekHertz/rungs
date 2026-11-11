import { describe, expect, it } from "vitest";
import { bandedSpan, rowsFromText } from "../src/diff.ts";

describe("bandedSpan", () => {
  const rows = rowsFromText("a\nb\nc\nd\ne\n", 8);
  it("spans the numbered rows of the range", () => {
    expect(bandedSpan(rows, { start: 10, end: 11 })).toEqual({ from: 2, to: 3 });
  });
  it("is a span of row indexes, so a fold opening above cannot move it", () => {
    expect(bandedSpan(rows, { start: 8, end: 8 })).toEqual({ from: 0, to: 0 });
  });
  it("is undefined when the range misses the rows", () => {
    expect(bandedSpan(rows, { start: 1, end: 3 })).toBeUndefined();
  });
});
