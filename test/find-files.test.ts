import { expect, test } from "vitest";
import { filterFiles, isTyping, moveActive } from "../src/find-files.ts";
import { CONTRACT_WORD, OUTCOME_GLYPH, OUTCOME_WORD } from "../src/mark-text.ts";

const files = ["src/page/main.ts", "src/main.ts", "test/main.test.ts", "README.md", "src/Review.ts", "docs/adr/0001-main-idea.md"].map((path) => ({ path }));
const paths = (query: string, limit?: number): string[] => filterFiles(files, query, limit).shown.map((file) => file.path);

test("an empty or blank query matches nothing", () => {
  expect(filterFiles(files, "")).toEqual({ shown: [], total: 0 });
  expect(filterFiles(files, "   ")).toEqual({ shown: [], total: 0 });
});

test("a query matches any part of the path, ignoring case", () => {
  expect(paths("REVIEW")).toEqual(["src/Review.ts"]);
  expect(paths("adr")).toEqual(["docs/adr/0001-main-idea.md"]);
});

test("every word must match somewhere in the path", () => {
  expect(paths("src main")).toEqual(["src/main.ts", "src/page/main.ts"]);
  expect(paths("src nothing")).toEqual([]);
});

test("a file name that starts with the word comes before one that only holds it, then shorter paths first", () => {
  expect(paths("main")).toEqual(["src/main.ts", "src/page/main.ts", "test/main.test.ts", "docs/adr/0001-main-idea.md"]);
});

test("a file with no risk is found like any other", () => {
  expect(paths("readme")).toEqual(["README.md"]);
});

test("the list is capped and the total says how many more match", () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ path: `src/file${i}.ts` }));
  const found = filterFiles(many, "file", 50);
  expect(found.shown).toHaveLength(50);
  expect(found.total).toBe(120);
});

test("the highlight wraps and starts from nothing", () => {
  expect(moveActive(-1, "ArrowDown", 3)).toBe(0);
  expect(moveActive(2, "ArrowDown", 3)).toBe(0);
  expect(moveActive(-1, "ArrowUp", 3)).toBe(2);
  expect(moveActive(0, "ArrowUp", 3)).toBe(2);
  expect(moveActive(1, "ArrowUp", 3)).toBe(0);
  expect(moveActive(1, "Home", 3)).toBe(0);
  expect(moveActive(0, "End", 3)).toBe(2);
  expect(moveActive(0, "ArrowDown", 0)).toBe(-1);
});

test("shortcuts are not read as text fields' keys", () => {
  expect(isTyping({ tagName: "INPUT" })).toBe(true);
  expect(isTyping({ tagName: "textarea" })).toBe(true);
  expect(isTyping({ tagName: "DIV", isContentEditable: true })).toBe(true);
  expect(isTyping({ tagName: "BUTTON" })).toBe(false);
  expect(isTyping(null)).toBe(false);
});

test("a pass or fail mark carries a word, not only its glyph", () => {
  expect(OUTCOME_GLYPH.fail).toBe("✗");
  expect(OUTCOME_WORD).toEqual({ fail: "failed", pass: "passed", skip: "skipped", none: "no result" });
  expect(CONTRACT_WORD.exposed).toBe("now exported");
});
