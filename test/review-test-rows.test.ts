import { describe, expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { testChanges } from "../src/test-changes.ts";
import { unmentioned } from "../src/review.ts";
import type { ReviewEntry } from "../src/review.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));

function reviewTests(base: Record<string, string>, head: Record<string, string>, description: string) {
  const headGraph = extract(tree(head));
  const comparison = compare(extract(tree(base)), headGraph);
  return unmentioned(comparison, pictureOf(headGraph, comparison).graph, description, new Set(), testChanges(tree(base), tree(head), { places: true }));
}

const T = "t.test.ts";
const spec = (title: string, body: string): string => `import { describe, it, expect } from "vitest";\ndescribe("town", () => {\n  it(${title}, () => {\n${body}  });\n});\n`;
const two = "    expect(a).toBe(1);\n    expect(b).toBe(2);\n";
const rowsOf = (entries: readonly ReviewEntry[]): ReviewEntry[] => entries.flatMap((entry) => entry.children).filter((child) => child.level === "function" && child.label.startsWith("it("));

describe("a rename of a test that compares reports as moved is still one renamed row", () => {
  const base = { [T]: spec('"old"', two) };
  const head = { [T]: spec('"new"', two) };

  test("the identical body gives one row with the old name as detail", () => {
    const rows = rowsOf(reviewTests(base, head, "").entries);
    expect(rows.map((row) => row.label)).toEqual(['it("new")']);
    const row = rows[0]!;
    expect(row.level === "function" && [row.renamedFrom, row.change]).toEqual(['it("old")', "moved"]);
  });

  test("a mention of either qualified name covers it", () => {
    expect(rowsOf(reviewTests(base, head, 'Renames `"describe(\\"town\\") callback"."it(\\"old\\") callback"`.').entries)).toEqual([]);
    expect(rowsOf(reviewTests(base, head, 'Renames `"describe(\\"town\\") callback"."it(\\"new\\") callback"`.').entries)).toEqual([]);
  });
});

describe("a title with escapes pairs like any other", () => {
  test("a title with quotes and a backslash is one renamed row", () => {
    const base = { [T]: spec(JSON.stringify('old "name" \\ here'), two) };
    const head = { [T]: spec('"new"', two + "    expect(c).toBe(3);\n") };
    const rows = rowsOf(reviewTests(base, head, "").entries);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.level === "function" && [row.label, row.renamedFrom, row.change]).toEqual(['it("new")', 'it("old \\"name\\" \\\\ here")', "altered"]);
  });

  test("and it carries the weakened mark when it asserts less", () => {
    const base = { [T]: spec(JSON.stringify('old "name"'), two) };
    const head = { [T]: spec('"new"', "    expect(a).toBe(1);\n") };
    const row = rowsOf(reviewTests(base, head, "").entries)[0]!;
    expect(row.level === "function" && [row.renamedFrom, row.weakened]).toEqual(['it("old \\"name\\"")', true]);
  });

  test("the same two tests with a describe titled with the separator stay one row each way", () => {
    const text = (title: string): string => `import { describe, it, expect } from "vitest";\ndescribe("a > b", () => {\n  it("${title}", () => {\n    expect(a).toBe(1);\n    expect(b).toBe(2);\n  });\n});\n`;
    const rows = rowsOf(reviewTests({ [T]: text("old") }, { [T]: text("new") }, "").entries);
    expect(rows.map((row) => row.label)).toEqual(['it("new")']);
  });
});

describe("a mention of either test's title or displayed name covers the renamed row", () => {
  const base = { [T]: spec('"old name"', two) };
  const head = { [T]: spec('"new name"', two + "    expect(c).toBe(3);\n") };
  const shown = (description: string): number => rowsOf(reviewTests(base, head, description).entries).length;

  test("with nothing mentioned, the row stays", () => {
    expect(shown("Nothing.")).toBe(1);
  });

  test.each(["Renames old name to new name.", 'Updates it("old name").', "Updates the `new name` test.", "The town > old name test.", "town > new name is clearer."])("%s", (description) => {
    expect(shown(description)).toBe(0);
  });

  test("a title that only shares a word with a mention is not covered", () => {
    expect(shown("Renames the old things.")).toBe(1);
  });
});

describe("callback roll-up in Unmentioned", () => {
  const pkg = { "package.json": "{}\n" };

  test("a test.each row keeps a row labelled by its test name", () => {
    const code = (n: number): string => `import { test, expect } from "vitest";\ntest.each([1])("works %s", (x) => {\n  expect(x + ${n}).toBe(2);\n});\n`;
    const result = reviewTests({ ...pkg, [T]: code(1) }, { ...pkg, [T]: code(2) }, "Nothing.");
    expect(result.entries[0]!.children.map((child) => child.label)).toEqual(['test.each("works %s")']);
    expect((result.entries[0] as { folded?: unknown[] }).folded).toBeUndefined();
  });

  test("an ordinary method named skip or only folds into the enclosing function", () => {
    const code = (n: number): string => `export function setup() {\n  stream.skip("data", () => consume(${n}));\n  stream.only("end", () => done(${n}));\n}\n`;
    const result = reviewTests({ ...pkg, "src/s.ts": code(1) }, { ...pkg, "src/s.ts": code(2) }, "Nothing.");
    const holder = result.entries[0]!.children[0]! as { label: string; folded?: unknown[] };
    expect(result.entries[0]!.children.map((child) => child.label)).toEqual(["setup"]);
    expect(holder.folded).toHaveLength(2);
  });

  test("the real it.skip in a test file still keeps its row", () => {
    const code = (n: number): string => `import { describe, it } from "vitest";\ndescribe.only("d", () => {\n  it.skip("x", () => {\n    f(${n});\n  });\n});\n`;
    const result = reviewTests({ ...pkg, [T]: code(1) }, { ...pkg, [T]: code(2) }, "Nothing.");
    expect(result.entries[0]!.children.map((child) => child.label)).toContain('skip("x")');
  });

  test("a stream.skip callback inside a test folds into that test, not the file", () => {
    const code = (n: number): string => `import { it } from "vitest";\nit("reads", () => {\n  stream.skip("data", () => consume(${n}));\n});\n`;
    const result = reviewTests({ ...pkg, [T]: code(1) }, { ...pkg, [T]: code(2) }, "Nothing.");
    expect(result.entries[0]!.children.map((child) => child.label)).toEqual(['it("reads")']);
    expect((result.entries[0]!.children[0] as { folded?: unknown[] }).folded).toHaveLength(1);
  });

  test("a class-field callback folds into its class", () => {
    const code = (n: number): string => `export class C {\n  value = [1].map((x) => x + ${n});\n}\n`;
    const result = reviewTests({ ...pkg, "src/c.ts": code(1) }, { ...pkg, "src/c.ts": code(2) }, "Nothing.");
    const holder = result.entries[0]!.children[0]! as { label: string; folded?: unknown[] };
    expect([holder.label, holder.folded?.length]).toEqual(["C", 1]);
    expect((result.entries[0] as { folded?: unknown[] }).folded).toBeUndefined();
  });
});
