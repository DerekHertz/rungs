import { expect, test } from "vitest";
import { filterFiles, isTyping, moveActive, searchEntries } from "../src/find-files.ts";
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

test("the path typed in full is always listed first, with its own case before another case", () => {
  const many = [...Array.from({ length: 80 }, (_, i) => ({ path: `src/a/main${i}.ts` })), { path: "src/Main.ts" }, { path: "src/main.ts" }];
  expect(filterFiles(many, "src/main.ts", 5).shown.map((f) => f.path).slice(0, 2)).toEqual(["src/main.ts", "src/Main.ts"]);
  const deep = [...Array.from({ length: 80 }, (_, i) => ({ path: `a/b/x${i}/index.ts` })), { path: "z/index.ts" }];
  expect(filterFiles(deep, "z/index.ts", 3).shown.map((f) => f.path)).toContain("z/index.ts");
});

test("a path prefix ranks before a name that only contains the word, and a larger limit lists every match", () => {
  const set = [{ path: "lib/xsrc.ts" }, { path: "src/zed.ts" }];
  expect(filterFiles(set, "src").shown.map((f) => f.path)).toEqual(["src/zed.ts", "lib/xsrc.ts"]);
  const found = filterFiles(Array.from({ length: 70 }, (_, i) => ({ path: `f${i}.ts` })), "f", Infinity);
  expect(found.shown).toHaveLength(70);
});

test("a file a move left behind is listed under its old path as moved, and choosing it goes to the new file", () => {
  const list = [{ id: "file:old.ts", path: "old.ts" }, { id: "file:new.ts", path: "new.ts" }, { id: "file:same.ts", path: "same.ts" }];
  const moved = new Map([["file:old.ts", { id: "file:new.ts", path: "new.ts" }]]);
  const entries = searchEntries(list, (id) => (id === "file:new.ts" ? "moved" : undefined), moved, true);
  expect(entries[0]).toEqual({ id: "file:new.ts", path: "old.ts", change: "moved to new.ts" });
  expect(entries[1]!.change).toBe("moved");
  expect(entries[2]!.change).toBe("unchanged");
  expect(searchEntries(list, () => undefined, new Map(), false).map((e) => e.change)).toEqual(["", "", ""]);
});

test("a pass or fail mark carries a word, not only its glyph", () => {
  expect(OUTCOME_GLYPH.fail).toBe("✗");
  expect(OUTCOME_WORD).toEqual({ fail: "failed", pass: "passed", skip: "skipped", none: "no result" });
  expect(CONTRACT_WORD.exposed).toBe("now exported");
});
