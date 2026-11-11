import { expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { markdownSections } from "../src/extract/markdown.ts";
import type { FileTree } from "../src/graph.ts";

const texts = (text: string): string[] => markdownSections(text).map((heading) => heading.text);
const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));

test("a fence opened inside a blockquoted list item hides what is in it", () => {
  expect(texts("> - ```\n>   # in\n>   ```\n\n# After\n")).toEqual(["After"]);
});

test("a fence is closed when its blockquote or list item ends", () => {
  expect(texts("> ```\n> # in\n\n# Real\n")).toEqual(["Real"]);
  expect(texts("- ```\n  # in\n# Real\n")).toEqual(["Real"]);
  expect(texts("> ~~~\n> # in\n# Real\n## Sub\n")).toEqual(["Real", "Sub"]);
});

test("dedenting from a nested list keeps the outer item's content column", () => {
  const text = "# Top\n- outer\n  - inner\n    ```\n    # in\n    ```\n  # Still outer\n";
  expect(texts(text)).toEqual(["Top", "Still outer"]);
  // A fence opened at the outer item's column after the dedent belongs to the outer item and runs to its end.
  expect(texts("- outer\n  - inner\n  ```\n  # in\n# After\n")).toEqual(["After"]);
});

test("a heading inside a block quote or a list item is a heading, as CommonMark has it", () => {
  expect(markdownSections("# A\n> ## Quoted\n- ### Listed\n\n## B\n")).toEqual([
    { text: "A", level: 1, start: 1, end: 5 },
    { text: "Quoted", level: 2, start: 2, end: 4 },
    { text: "Listed", level: 3, start: 3, end: 4 },
    { text: "B", level: 2, start: 5, end: 5 },
  ]);
});

test("setext headings are sections, level 1 for = and 2 for -", () => {
  expect(markdownSections("One\n===\nbody\n\nTwo\n---\nmore\n")).toEqual([
    { text: "One", level: 1, start: 1, end: 7 },
    { text: "Two", level: 2, start: 5, end: 7 },
  ]);
  // A thematic break and a list are not setext headings.
  expect(texts("---\n\n- a\n- b\n")).toEqual([]);
  // A multi-line setext heading starts on its first line and reads as one phrase.
  expect(markdownSections("> first\n> second\n> ===\n")).toEqual([{ text: "first second", level: 1, start: 1, end: 3 }]);
});

test("indented code, a lone carriage return and a missing final newline", () => {
  expect(texts("para\n\n    # code\n\n# Real")).toEqual(["Real"]);
  expect(markdownSections("a\r# not a heading\n# Real\n")).toEqual([{ text: "Real", level: 1, start: 2, end: 2 }]);
  expect(markdownSections("# A\r\nbody\r\n## B\r\n")).toEqual([
    { text: "A", level: 1, start: 1, end: 3 },
    { text: "B", level: 2, start: 3, end: 3 },
  ]);
});

test("lines come from lines.ts, so U+2028 does not start a line", () => {
  expect(markdownSections("# A B\n## C\n")).toEqual([
    { text: "A B", level: 1, start: 1, end: 2 },
    { text: "C", level: 2, start: 2, end: 2 },
  ]);
});

test("empty and heading-free files have no sections", () => {
  expect(markdownSections("")).toEqual([]);
  expect(markdownSections("just words\n")).toEqual([]);
});

const bigRun = (word: string): string => `${word}\n`.repeat(2100);

test("the large-diff fallback sees a change to the final newline", () => {
  // Past the search budget diffText gives up, and the fallback must still see `same\n` become `same`.
  const baseTree = tree({ "a.md": `# A\n${bigRun("x")}${bigRun("y")}# B\nsame\n` });
  const headTree = tree({ "a.md": `# A\n${bigRun("y")}${bigRun("x")}# B\nsame` });
  const sections = compare(extract(baseTree), extract(headTree), { base: baseTree, head: headTree }).sections;
  expect(sections.map((s) => [s.name, s.plus, s.minus])).toEqual([
    ["A", 4200, 4200],
    // The fallback credits the whole middle, so the unchanged heading line before `same` counts too.
    ["B", 2, 2],
  ]);
});
