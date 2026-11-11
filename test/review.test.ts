import { expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { appears, unmentioned } from "../src/review.ts";
import type { ReviewEntry } from "../src/review.ts";

const fn = (name: string, body = 1): string => `export function ${name}() {\n  return ${body};\n}\n`;
const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));

function review(base: Record<string, string>, head: Record<string, string>, description: string, linked: readonly string[] = []) {
  const headGraph = extract(tree(head));
  const comparison = compare(extract(tree(base)), headGraph);
  return unmentioned(comparison, pictureOf(headGraph, comparison).graph, description, new Set(linked as NodeId[]));
}

const labels = (entries: readonly ReviewEntry[]): string[] => entries.map((entry) => entry.label);

test("a path appears whole, not inside a longer path or a longer file name", () => {
  expect(appears("Changed `src/a.ts`.", "path", "src/a.ts")).toBe(true);
  expect(appears("see src/a.ts, then more", "path", "src/a.ts")).toBe(true);
  expect(appears("lib/src/a.ts", "path", "src/a.ts")).toBe(false);
  expect(appears("xsrc/a.ts", "path", "src/a.ts")).toBe(false);
  expect(appears("src/a.ts.map", "path", "src/a.ts")).toBe(false);
  expect(appears("src/a.tsx", "path", "src/a.ts")).toBe(false);
  expect(appears("src/a.ts/", "path", "src/a.ts")).toBe(false);
});

test("a base name appears after a slash or on its own, never inside a longer name", () => {
  expect(appears("edit a.ts", "file", "a.ts")).toBe(true);
  expect(appears("edit lib/a.ts now", "file", "a.ts")).toBe(true);
  expect(appears("data.ts", "file", "a.ts")).toBe(false);
  expect(appears("my-a.ts", "file", "a.ts")).toBe(false);
  expect(appears("a.tsx and a.ts.map", "file", "a.ts")).toBe(false);
});

test("a name appears on identifier boundaries, case-sensitively, with a qualified name whole", () => {
  expect(appears("calls parseOptions() now", "name", "parseOptions")).toBe(true);
  expect(appears("the `Foo.bar` method", "name", "Foo.bar")).toBe(true);
  expect(appears("obj.parseOptions", "name", "parseOptions")).toBe(true);
  expect(appears("parseOptionsFor", "name", "parseOptions")).toBe(false);
  expect(appears("reparseOptions", "name", "parseOptions")).toBe(false);
  expect(appears("$parseOptions", "name", "parseOptions")).toBe(false);
  expect(appears("parseoptions", "name", "parseOptions")).toBe(false);
  expect(appears("Foo", "name", "Foo.bar")).toBe(false);
});

const base = {
  "package.json": "{}\n",
  "src/a.ts": fn("alpha") + fn("beta"),
  "src/b.ts": fn("bravo"),
  "src/c.ts": fn("charlie"),
};

test("an altered file is unmentioned until its path appears, and then so is its code", () => {
  const head = { ...base, "src/a.ts": fn("alpha", 2) + fn("beta", 2) };
  const none = review(base, head, "Tidies things up.");
  expect(labels(none.entries)).toEqual(["src/a.ts"]);
  expect(labels(none.entries[0]!.children)).toEqual(["alpha", "beta"]);
  expect(review(base, head, "Touches src/a.ts only.").entries).toEqual([]);
});

test("a function name mentions that function and leaves its siblings listed", () => {
  const head = { ...base, "src/a.ts": fn("alpha", 2) + fn("beta", 2) };
  const result = review(base, head, "Fixes alpha().");
  expect(labels(result.entries)).toEqual(["src/a.ts"]);
  expect(labels(result.entries[0]!.children)).toEqual(["beta"]);
});

test("a base name mentions its file only when no other changed file shares it", () => {
  const twoIndexes = {
    "package.json": "{}\n",
    "x/index.ts": fn("one"),
    "y/index.ts": fn("two"),
  };
  const changed = { ...twoIndexes, "x/index.ts": fn("one", 2), "y/index.ts": fn("two", 2) };
  expect(labels(review(twoIndexes, changed, "Edits index.ts.").entries)).toEqual(["x/index.ts", "y/index.ts"]);
  expect(review(twoIndexes, changed, "Edits x/index.ts and y/index.ts.").entries).toEqual([]);
  const head = { ...base, "src/b.ts": fn("bravo", 2) };
  expect(review(base, head, "Edits b.ts.").entries).toEqual([]);
});

test("a moved file is mentioned when either its old or new path appears", () => {
  const before = { "package.json": "{}\n", "src/c.ts": base["src/c.ts"] };
  const after = { "package.json": "{}\n", "lib/c2.ts": base["src/c.ts"] };
  expect(review(before, after, "Moves src/c.ts away.").entries).toEqual([]);
  expect(review(before, after, "Moves it to lib/c2.ts.").entries).toEqual([]);
  expect(review(before, after, "Moves it.").entries).toMatchObject([
    { label: "lib/c2.ts", change: "moved", from: "src/c.ts" },
  ]);
});

test("a removed file is listed by its old path and its function children", () => {
  const head = { "package.json": "{}\n", "src/a.ts": base["src/a.ts"], "src/c.ts": base["src/c.ts"] };
  const result = review(base, head, "Nothing relevant.");
  expect(result.entries).toMatchObject([
    { label: "src/b.ts", change: "removed", id: "file:src/b.ts", children: [{ label: "bravo", change: "removed" }] },
  ]);
});

test("a folder whose changed files are all unmentioned is listed once, with its count", () => {
  const head = {
    ...base,
    "lib/one.ts": fn("one"),
    "lib/two.ts": fn("two"),
    "lib/deep/three.ts": fn("three"),
  };
  const result = review(base, head, "Adds stuff.");
  expect(result.changedFiles).toBe(3);
  expect(result.unmentionedFiles).toBe(3);
  expect(result.entries).toMatchObject([
    { level: "district", label: "lib", id: "folder:lib", files: 3, kinds: { added: 3, altered: 0, removed: 0, moved: 0 } },
  ]);
  expect(labels(result.entries[0]!.children)).toEqual(["lib/deep/three.ts", "lib/one.ts", "lib/two.ts"]);
});

test("a mentioned file splits the folder, and the largest all-unmentioned subfolder rolls up", () => {
  const head = {
    ...base,
    "lib/one.ts": fn("one"),
    "lib/deep/three.ts": fn("three"),
    "lib/deep/four.ts": fn("four"),
  };
  const result = review(base, head, "Adds lib/one.ts.");
  expect(result.entries).toMatchObject([{ level: "district", label: "lib/deep", files: 2 }]);
  expect(result.unmentionedFiles).toBe(2);
});

test("one unmentioned file in a folder is a file row, and the repository root never rolls up", () => {
  const head = { ...base, "src/a.ts": fn("alpha", 9), "src/b.ts": fn("bravo", 9), "top.ts": fn("top") };
  const result = review(base, head, "Nothing.");
  expect(result.entries.every((entry) => entry.level !== "district" || entry.label !== "")).toBe(true);
  expect(result.entries).toMatchObject([
    { level: "district", label: "src", files: 2 },
    { level: "file", label: "top.ts" },
  ]);
});

test("removed come before altered before added before moved, then larger before smaller", () => {
  const head = {
    "package.json": "{}\n",
    "src/a.ts": fn("alpha", 9) + fn("beta", 9),
    "src/c.ts": fn("charlie", 9),
    "x/new-big.ts": fn("one") + fn("two") + fn("three"),
    "y/new-small.ts": fn("four"),
    "m/moved.ts": base["src/b.ts"],
  };
  const result = review(base, head, "Nothing.");
  const kinds = result.entries.map((entry) => (entry.level === "district" ? "district" : entry.change));
  expect(kinds).toEqual(["district", "added", "added", "moved"]);
  expect(labels(result.entries)).toEqual(["src", "x/new-big.ts", "y/new-small.ts", "m/moved.ts"]);
});

test("a district sorts by its most urgent kind, and its children sort the same way", () => {
  const head = { "package.json": "{}\n", "src/a.ts": base["src/a.ts"], "src/c.ts": fn("charlie", 9), "src/new.ts": fn("n") };
  const result = review(base, head, "Nothing.");
  expect(result.entries).toMatchObject([{ level: "district", label: "src", files: 3 }]);
  expect(labels(result.entries[0]!.children)).toEqual(["src/b.ts", "src/c.ts", "src/new.ts"]);
});

test("code under a mentioned file is covered by it", () => {
  const head = { ...base, "src/a.ts": fn("alpha", 2) + fn("gamma") };
  expect(review(base, head, "In src/a.ts.").entries).toEqual([]);
});

test("a moved file's old base name counts toward ambiguity", () => {
  const before = { "package.json": "{}\n", "src/a.ts": "export const a = 1;\n", "other/a.ts": "export const b = 1;\n" };
  const after = { "package.json": "{}\n", "lib/b.ts": "export const a = 1;\n", "other/a.ts": "export const b = 2;\n" };
  expect(labels(review(before, after, "Update a.ts").entries)).toEqual(["other/a.ts", "lib/b.ts"]);
});

test("a Unicode letter beside a needle is part of a longer name", () => {
  expect(appears("Update \u00e9a.ts", "file", "a.ts")).toBe(false);
  expect(appears("Fix \u00e9parse()", "name", "parse")).toBe(false);
  expect(appears("Fix parse\u00e9()", "name", "parse")).toBe(false);
  expect(appears("x/\u00e9a.ts", "path", "a.ts")).toBe(false);
  expect(appears("Fix foo\u200Cbar()", "name", "foo")).toBe(false);
  expect(appears("Fix foo\u200Dbar()", "name", "foo")).toBe(false);
  expect(appears("Fix parse()", "name", "parse")).toBe(true);
});

const altered = { ...base, "src/a.ts": fn("alpha", 2) + fn("beta", 2), "src/b.ts": fn("bravo", 2), "src/c.ts": fn("charlie", 2) };

test("with no links, nothing is linked and the entries are as before", () => {
  const result = review(base, altered, "Nothing.");
  expect(result.linkedFiles).toBe(0);
  expect(result.linkedEntries).toEqual([]);
  expect(labels(result.entries)).toEqual(["src"]);
});

test("a file the agent linked leaves 'no claim covers it' for 'linked by the agent only', and stays in view", () => {
  const result = review(base, altered, "Nothing.", ["file:src/b.ts", "file:src/c.ts", "file:src/a.ts"]);
  expect(result.unmentionedFiles).toBe(3);
  expect(result.linkedFiles).toBe(3);
  expect(result.entries).toEqual([]);
  expect(result.linkedEntries).toMatchObject([{ level: "district", label: "src", files: 3 }]);
});

test("a link to a function links its file, and the linked function is marked among its siblings", () => {
  const result = review(base, altered, "Nothing.", ["function:src/a.ts#alpha"]);
  expect(result.linkedFiles).toBe(1);
  expect(labels(result.entries)).toEqual(["src/b.ts", "src/c.ts"]);
  expect(result.linkedEntries).toMatchObject([
    { label: "src/a.ts", children: [{ label: "alpha", linked: true }, { label: "beta" }] },
  ]);
  expect(result.linkedEntries[0]!.children[1]).not.toHaveProperty("linked");
});

test("a name match wins over a link: a mentioned file is in neither list", () => {
  const result = review(base, altered, "Edits src/a.ts, src/b.ts and src/c.ts.", ["file:src/a.ts"]);
  expect(result.unmentionedFiles).toBe(0);
  expect(result.linkedFiles).toBe(0);
  expect(result.entries).toEqual([]);
  expect(result.linkedEntries).toEqual([]);
});

test("roll-up applies to each list on its own: a folder rolls up only when all its changed files are in the list", () => {
  const head = { ...base, "lib/one.ts": fn("one"), "lib/two.ts": fn("two"), "lib/three.ts": fn("three") };
  const mixed = review(base, head, "Nothing.", ["file:lib/one.ts"]);
  expect(labels(mixed.entries)).toEqual(["lib/three.ts", "lib/two.ts"]);
  expect(labels(mixed.linkedEntries)).toEqual(["lib/one.ts"]);
  const all = review(base, head, "Nothing.", ["file:lib/one.ts", "file:lib/two.ts", "file:lib/three.ts"]);
  expect(all.entries).toEqual([]);
  expect(all.linkedEntries).toMatchObject([{ level: "district", label: "lib", files: 3 }]);
});

test("an id that names no changed module links nothing", () => {
  const result = review(base, altered, "Nothing.", ["file:src/zzz.ts", "folder:src"]);
  expect(result.linkedFiles).toBe(0);
});

test("an empty needle never appears, whatever the kind", () => {
  for (const kind of ["path", "file", "name"] as const) {
    for (const text of ["x", "", " ", "a b"]) expect(appears(text, kind, "")).toBe(false);
    for (const blank of [" ", "\n", "\t ", "\u00a0"]) expect(appears("Summary.\n\nDetails. a b", kind, blank)).toBe(false);
  }
});

const mapper = (body: number): string =>
  `export function townOf(xs: number[]) {\n  return xs.map((x) => x + ${body}).filter((x) => x > ${body});\n}\n`;
const pkg = { "package.json": "{}\n" };

test("an anonymous callback is never its own row: its change rolls up into the named function holding it", () => {
  const none = review({ ...pkg, "src/t.ts": mapper(1) }, { ...pkg, "src/t.ts": mapper(2) }, "Tidies things up.");
  const [file] = none.entries;
  expect(labels(file!.children)).toEqual(["townOf"]);
  const holder = file!.children[0]! as { change: string; folded?: unknown[] };
  expect(holder.change).toBe("altered");
  expect(holder.folded).toHaveLength(2);
});

test("a callback under a name the description mentions stays covered", () => {
  const none = review({ ...pkg, "src/t.ts": mapper(1) }, { ...pkg, "src/t.ts": mapper(2) }, "Reworks townOf.");
  expect(none.entries[0]?.children ?? []).toEqual([]);
});

test("a callback at the top of a file rolls up into the file", () => {
  const code = (n: number): string => `[1].forEach((x) => x + ${n});\n`;
  const none = review({ ...pkg, "src/t.ts": code(1) }, { ...pkg, "src/t.ts": code(2) }, "Nothing.");
  expect(none.entries[0]!.children).toEqual([]);
  expect((none.entries[0] as { folded?: unknown[] }).folded).toHaveLength(1);
});

test("a test callback shows its innermost test name, not the describe prefix", () => {
  const spec = (n: number): string =>
    `describe("code loaded at run time", () => {\n  test("a literal import() stays a resolution", () => {\n    expect(${n}).toBe(1);\n  });\n});\n`;
  const none = review({ ...pkg, "src/t.test.ts": spec(1) }, { ...pkg, "src/t.test.ts": spec(2) }, "Nothing.");
  const shown = labels(none.entries[0]!.children);
  expect(shown).toContain('test("a literal import() stays a resolution")');
  expect(shown.every((label) => !label.includes(" callback"))).toBe(true);
});

test("an ordinary callback with a string argument folds too; only test runner callbacks keep a row", () => {
  const code = (n: number): string => `export function setup() {\n  server.on("data", () => consume(${n}));\n}\n`;
  const none = review({ ...pkg, "src/t.ts": code(1) }, { ...pkg, "src/t.ts": code(2) }, "Nothing.");
  expect(labels(none.entries[0]!.children)).toEqual(["setup"]);
  const spec = (n: number): string => `describe.only("d", () => {\n  it.skip("x", () => {\n    f(${n});\n  });\n});\n`;
  const tests = review({ ...pkg, "src/t.test.ts": spec(1) }, { ...pkg, "src/t.test.ts": spec(2) }, "Nothing.");
  expect(labels(tests.entries[0]!.children)).toContain('skip("x")');
});

test("callbacks inside a removed callback fold into the surviving function, not the file", () => {
  const before = `export function setup() {\n  return [1].map((x) => [2].map((y) => y + 1));\n}\n`;
  const after = `export function setup() {\n  return [];\n}\n`;
  const none = review({ ...pkg, "src/t.ts": before }, { ...pkg, "src/t.ts": after }, "Nothing.");
  const holder = none.entries[0]!.children[0]! as { folded?: unknown[] };
  expect(labels(none.entries[0]!.children)).toEqual(["setup"]);
  expect(holder.folded).toHaveLength(2);
  expect((none.entries[0] as { folded?: unknown[] }).folded).toBeUndefined();

test("a binary file has no line count, and rows are not ordered by one", () => {
  const png = "\u0089PNG\0\n\n\n\n\n\n\n\n";
  const result = review({ "a.ts": fn("a") }, { "a.ts": fn("a"), "img/x.png": png, "y.ts": "one\n" }, "nothing");
  const all = [...result.entries, ...result.linkedEntries];
  const byLabel = new Map(all.flatMap((entry) => [entry, ...entry.children]).map((entry) => [entry.label, entry]));
  expect(byLabel.get("img/x.png")?.lines).toBeNull();
  expect(byLabel.get("y.ts")?.lines).toBe(1);
});
