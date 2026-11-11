import { describe, expect, test } from "vitest";
import { countLines, isBinary, lineRangeOf, lineStarts, sliceLines, splitLines } from "../src/lines.ts";

const TEXTS = [
  "",
  "a",
  "a\n",
  "\n",
  "\n\n",
  "a\nb",
  "a\nb\n",
  "a\r\nb\r\n",
  "a\r\nb",
  "a\rb\n",
  "x y z\n",
  'const s = " ";\nfunction f() {}',
  "\n\nlast",
];

const lineOfOffset = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

describe("lines", () => {
  test("counts lines as text ending at each \\n, plus a final line without one", () => {
    expect(TEXTS.map(countLines)).toEqual([0, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 2, 3]);
  });

  test.each(TEXTS)("agree with each other on %j", (text) => {
    const starts = lineStarts(text);
    const count = countLines(text);
    expect(starts).toHaveLength(count);

    for (let offset = 0; offset < text.length; offset++) {
      const line = lineOfOffset(text, offset);
      expect(lineRangeOf(starts, offset, offset + 1)).toEqual({ start: line, end: line });
    }
    if (text.length > 0) expect(lineRangeOf(starts, 0, text.length)).toEqual({ start: 1, end: count });

    const each = Array.from({ length: count }, (_, i) => sliceLines(text, { start: i + 1, end: i + 1 }));
    for (const line of each) expect(line).not.toContain("\n");
    if (count > 0) {
      const whole = sliceLines(text, { start: 1, end: count });
      expect(whole).toBe(each.join("\n"));
      expect(text.endsWith("\n") ? `${whole}\n` : whole).toBe(text);
    }
  });

  test("keeps \\r, U+2028 and U+2029 inside a line", () => {
    expect(sliceLines("a\r\nb\r\n", { start: 2, end: 2 })).toBe("b\r");
    expect(sliceLines("x y\n", { start: 1, end: 1 })).toBe("x y");
    const text = 'const s = " ";\nfunction f() {}';
    const start = text.indexOf("function");
    expect(lineRangeOf(lineStarts(text), start, text.length)).toEqual({ start: 2, end: 2 });
  });

  test("slices a range of lines out of the middle of a file", () => {
    expect(sliceLines("one\ntwo\nthree\nfour\n", { start: 2, end: 3 })).toBe("two\nthree");
  });
});

test("splitLines gives as many lines as countLines, whatever the text ends with", () => {
  for (const text of TEXTS) expect(splitLines(text)).toHaveLength(countLines(text));
  expect(splitLines("a\r\nb\n")).toEqual(["a\r", "b"]);
});

describe("isBinary", () => {
  test("a NUL byte in the first 8000 characters makes a file binary, as in git", () => {
    expect(isBinary("PNG\0data")).toBe(true);
    expect(isBinary("a\n".repeat(10))).toBe(false);
    expect(isBinary("x".repeat(8000) + "\0")).toBe(false);
    expect(isBinary("x".repeat(7999) + "\0")).toBe(true);
    expect(isBinary("")).toBe(false);
  });
});
