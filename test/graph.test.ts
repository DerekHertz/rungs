import { describe, expect, test } from "vitest";
import { qualifiedName } from "../src/graph.ts";

const TEXTS = [
  "a",
  "b",
  "a@2",
  '"a"',
  "a.b",
  "#a",
  "\\u0023a",
  "get a",
  "",
  ".",
  "@",
  "🙂",
  'a"b',
  "\\",
  "<function>",
];
const ORDINALS = [1, 2, 3];

describe("qualifiedName", () => {
  const segments = TEXTS.flatMap((text) => ORDINALS.map((ordinal) => ({ text, ordinal })));
  const paths = [
    ...segments.map((segment) => [segment]),
    ...segments.flatMap((outer) => segments.map((inner) => [outer, inner])),
  ];
  const names = paths.map((path) =>
    path.reduce((parent, { text, ordinal }) => qualifiedName(parent, text, ordinal), ""),
  );

  test("gives distinct names to distinct paths of (text, ordinal)", () => {
    expect(new Set(names).size).toBe(paths.length);
  });

  test("never contains # and is never empty", () => {
    for (const name of names) {
      expect(name).not.toContain("#");
      expect(name).not.toBe("");
    }
  });

  test("writes identifiers bare, other texts as JSON strings, and ordinals after the first", () => {
    expect(qualifiedName("", "render", 1)).toBe("render");
    expect(qualifiedName("Square", "get side", 1)).toBe('Square."get side"');
    expect(qualifiedName("Square", "#grow", 2)).toBe('Square."\\u0023grow"@2');
    expect(qualifiedName("", "map() callback", 3)).toBe('"map() callback"@3');
  });
});
