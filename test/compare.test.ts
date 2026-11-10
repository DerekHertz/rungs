import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compare, contractsMoved, ExtractorVersionMismatch, serializeComparison, tally } from "../src/compare.ts";
import type { Comparison, ModuleChange } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { compareIds } from "../src/graph.ts";
import type { CodeNode, FileTree, Graph, NodeId } from "../src/graph.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const fixtureUrl = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const goldenPath = fileURLToPath(new URL("golden/compare.json", import.meta.url));

const base = extract(readFixtureTree(fixtureUrl("small")));
const head = extract(readFixtureTree(fixtureUrl("small-head")));
const comparison = compare(base, head);

/** One line per change: "added file:a.ts", "moved file:b.ts <- file:a.ts", "altered file:a.ts". */
function summarize(changes: readonly ModuleChange[]): string[] {
  return changes.map((change) => {
    switch (change.kind) {
      case "added":
      case "removed":
      case "altered":
        return `${change.kind} ${change.node.id}`;
      case "moved":
        return `moved ${change.node.id} <- ${change.from.id}`;
    }
  });
}

const treeOf = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const compareTrees = (before: Record<string, string>, after: Record<string, string>): Comparison =>
  compare(extract(treeOf(before)), extract(treeOf(after)));

describe("comparing the small fixture with the small-head fixture", () => {
  test("matches the committed golden comparison (UPDATE_GOLDEN=1 rewrites it)", () => {
    const serialized = serializeComparison(comparison);
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenPath, serialized);
    expect(serialized).toBe(readFileSync(goldenPath, "utf8"));
  });

  const lines = summarize(comparison.changes);

  test("carries the extractor version and sorts changes by id", () => {
    expect(comparison.extractorVersion).toBe(base.extractorVersion);
    const ids = comparison.changes.map((change) => change.node.id);
    expect(ids).toEqual([...ids].sort(compareIds));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("an edited function is altered, and so is its file; a function that only shifted is not", () => {
    expect(lines).toContain("altered function:src/util/math.ts#add");
    expect(lines).toContain("altered file:src/util/math.ts");
    expect(lines).toContain("added function:src/util/math.ts#sub");
    expect(lines).toContain("altered file:src/shapes.ts");
    expect(lines.filter((line) => line.includes("function:src/shapes.ts"))).toEqual([]);
  });

  test("an added and a removed file stand alone", () => {
    expect(lines).toContain("added file:packages/gadget/src/gadget.ts");
    expect(lines).toContain("added package:packages/gadget");
    expect(lines).toContain("removed folder:test");
    expect(lines).toContain("removed file:test/helpers.ts");
  });

  test("an identical file that moved is paired, and so are its code nodes", () => {
    expect(lines).toContain("moved file:src/compat/legacy.js <- file:src/legacy.js");
    expect(lines).toContain("moved function:src/compat/legacy.js#legacy <- function:src/legacy.js#legacy");
    expect(lines).not.toContain("removed file:src/legacy.js");
    expect(lines).not.toContain("added file:src/compat/legacy.js");
  });

  test("a function moved between files whose files do not pair is still paired", () => {
    expect(lines).toContain("moved function:src/util/format.ts#double <- function:test/helpers.ts#double");
    expect(lines).toContain("added function:src/util/format.ts#format");
  });

  test("a renamed and edited file is not paired, nor are its functions", () => {
    expect(lines).toContain("removed file:src/index.ts");
    expect(lines).toContain("added file:src/main.ts");
    expect(lines).toContain("removed function:src/index.ts#main");
    expect(lines).toContain("added function:src/main.ts#main");
  });

  test("one removed file with two identical added ones pairs with neither", () => {
    expect(lines).toContain("removed file:docs/notes.md");
    expect(lines).toContain("added file:docs/a.md");
    expect(lines).toContain("added file:docs/b.md");
    expect(lines.filter((line) => line.startsWith("moved") && line.includes("docs/"))).toEqual([]);
  });

  test("containers pair by path and are never altered, even when a folder became a package", () => {
    expect(lines.filter((line) => line.startsWith("altered") && /(package|folder):/.test(line))).toEqual([]);
    expect(lines.filter((line) => /(package|folder):src\/util$/.test(line))).toEqual([]);
    expect(lines).toContain("added file:src/util/package.json");
    expect(lines.filter((line) => /(package|folder):packages\/widget$/.test(line))).toEqual([]);
  });
});

describe("tally", () => {
  const counts = Object.fromEntries(
    [...tally(comparison, head)].map(([id, t]) => [id, `+${t.added} ~${t.altered} -${t.removed} >${t.moved}`]),
  );

  test("counts changed files by kind in every container above them, at their head location", () => {
    expect(counts).toEqual({
      "package:": "+7 ~3 -3 >1",
      "folder:docs": "+2 ~0 -1 >0",
      "folder:src": "+3 ~3 -1 >1",
      "package:src/util": "+2 ~1 -0 >0",
      "folder:src/compat": "+0 ~0 -0 >1",
      "folder:packages": "+2 ~0 -0 >0",
      "package:packages/gadget": "+2 ~0 -0 >0",
      "folder:packages/gadget/src": "+1 ~0 -0 >0",
    });
  });

  test("an unchanged tree tallies nothing", () => {
    expect(tally(compare(head, head), head).size).toBe(0);
  });

  test("counts files only, never classes or functions", () => {
    const only = compareTrees({ "a.ts": "export function f() { return 1; }\n" }, { "a.ts": "export function f() { return 2; }\n" });
    expect(summarize(only.changes)).toEqual(["altered file:a.ts", "altered function:a.ts#f"]);
    const counted = tally(only, extract(treeOf({ "a.ts": "export function f() { return 2; }\n" })));
    expect([...counted.values()]).toEqual([{ added: 0, altered: 1, removed: 0, moved: 0 }]);
  });
});

describe("pairing", () => {
  const body = (n: number) => `export function twin() {\n  return ${n};\n}\n`;

  test("two removed files with one added file of the same text pair with none", () => {
    const result = compareTrees({ "a/one.ts": body(7), "a/two.ts": body(7) }, { "b/one.ts": body(7) });
    expect(summarize(result.changes).filter((line) => line.startsWith("moved"))).toEqual([]);
  });

  test("one removed file with two added files of the same text pair with none", () => {
    const result = compareTrees({ "a/one.ts": body(7) }, { "b/one.ts": body(7), "b/two.ts": body(7) });
    expect(summarize(result.changes).filter((line) => line.startsWith("moved"))).toEqual([]);
  });

  test("two identical functions in different files are not paired when either side holds two", () => {
    const result = compareTrees(
      { "a.ts": `${body(1)}// a\n`, "b.ts": `// b\n${body(1)}` },
      { "c.ts": `// c\n${body(1)}` },
    );
    expect(summarize(result.changes).filter((line) => line.startsWith("moved"))).toEqual([]);
  });

  test("a code node left alone once a pair takes its twin still pairs", () => {
    const result = compareTrees(
      { "old.ts": "// old\nclass A { m() {} }\n", "other.ts": "class B { m() {} }\n" },
      { "new.ts": "// new\nclass A { m() {} }\n", "another.ts": "class C { m() {} }\n" },
    );
    expect(summarize(result.changes).filter((line) => line.startsWith("moved"))).toEqual([
      "moved class:new.ts#A <- class:old.ts#A",
      "moved function:another.ts#C.m <- function:other.ts#B.m",
      "moved function:new.ts#A.m <- function:old.ts#A.m",
    ]);
  });

  test("a class never pairs with a function of the same digest", () => {
    const id = (text: string) => text as NodeId;
    const code = (level: "class" | "function", name: string): CodeNode => ({
      id: id(`${level}:a.ts#${name}`),
      level,
      path: "a.ts",
      name,
      parent: id("file:a.ts"),
      qualifiedName: name,
      range: { start: 1, end: 1 },
      digest: "d".repeat(32),
      exported: false,
      signature: "()",
    });
    const graphOf = (digest: string, node: CodeNode): Graph => ({
      extractorVersion: "5",
      nodes: [
        { id: id("package:"), level: "package", path: "", name: "", parent: null, lines: 1 },
        {
          id: id("file:a.ts"),
          level: "file",
          path: "a.ts",
          name: "a.ts",
          parent: id("package:"),
          lines: 1,
          analysis: "analysed",
          role: "source",
          digest,
        },
        node,
      ],
      edges: [],
    });
    const result = compare(graphOf("a".repeat(32), code("class", "x")), graphOf("b".repeat(32), code("function", "y")));
    expect(summarize(result.changes)).toEqual([
      "removed class:a.ts#x",
      "altered file:a.ts",
      "added function:a.ts#y",
    ]);
  });

  test("a renamed function whose span stays identical is a move, with its nested functions", () => {
    const result = compareTrees(
      { "a.ts": "const a = () => {\n  const inner = () => 1;\n  return inner;\n};\n" },
      { "a.ts": "const b = () => {\n  const inner = () => 1;\n  return inner;\n};\n" },
    );
    expect(summarize(result.changes)).toEqual([
      "altered file:a.ts",
      "moved function:a.ts#b <- function:a.ts#a",
      "moved function:a.ts#b.inner <- function:a.ts#a.inner",
    ]);
  });
});

describe("refusing graphs from different extractor versions", () => {
  const unreadable = (version: string): Graph => ({
    extractorVersion: version,
    get nodes(): never {
      throw new Error("read a node");
    },
    edges: [],
  });

  test("throws before reading any node, naming both versions", () => {
    expect(() => compare(unreadable("4"), unreadable("5"))).toThrow(ExtractorVersionMismatch);
    expect(() => compare(unreadable("4"), unreadable("5"))).toThrow(
      "graphs from extractor 4 and 5 can't be compared",
    );
    try {
      compare(unreadable("4"), unreadable("5"));
    } catch (error) {
      expect(error).toMatchObject({ base: "4", head: "5" });
    }
  });
});

describe("properties over generated trees", () => {
  const SNIPPETS = [
    "",
    "plain text\n",
    "export function a() {\n  return 1;\n}\n",
    "export function a() {\n  return 2;\n}\n",
    "export function b() {}\nexport function c() {}\n",
    "class K {\n  m() {}\n  n() {}\n}\n",
    "const f = () => {\n  const g = () => 1;\n  return g;\n};\n",
    "const h = () => {\n  const g = () => 1;\n  return g;\n};\n",
    "// header\nexport function a() {\n  return 1;\n}\n",
  ];
  const PATHS = ["a.ts", "b.ts", "x/a.ts", "x/b.ts", "x/y/c.ts", "z/a.ts", "z/notes.md", "x/package.json", "w/e.ts"];

  function generate(seed: number): FileTree {
    let state = seed;
    const next = (n: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % n;
    };
    const tree = new Map<string, string>();
    for (const path of PATHS) {
      if (next(3) === 0) continue;
      tree.set(path, path.endsWith("package.json") ? "{}" : SNIPPETS[next(SNIPPETS.length)]!);
    }
    return tree;
  }

  const pairs = Array.from({ length: 300 }, (_, i) => [extract(generate(i)), extract(generate(i + 1000))] as const);

  test("compare(g, g) has no changes", () => {
    for (const [g] of pairs) expect(compare(g, g).changes).toEqual([]);
  });

  test("swapping the arguments swaps added with removed, before with node and from with node", () => {
    const swapped = (change: ModuleChange): ModuleChange => {
      switch (change.kind) {
        case "added":
          return { kind: "removed", node: change.node };
        case "removed":
          return { kind: "added", node: change.node };
        case "altered":
          return { kind: "altered", node: change.before, before: change.node };
        case "moved":
          return { kind: "moved", node: change.from, from: change.node };
      }
    };
    const sorted = (changes: readonly ModuleChange[]) =>
      [...changes].sort((a, b) => compareIds(a.node.id, b.node.id));
    for (const [a, b] of pairs) {
      expect(sorted(compare(b, a).changes)).toEqual(sorted(compare(a, b).changes.map(swapped)));
    }
  });

  test("changes are sorted with one per id, and each kind means what it says", () => {
    const seen = new Set<string>();
    for (const [a, b] of pairs) {
      const baseIds = new Map(a.nodes.map((node) => [node.id, node]));
      const headIds = new Map(b.nodes.map((node) => [node.id, node]));
      const { changes } = compare(a, b);
      for (const change of changes) seen.add(change.kind);
      const ids = changes.map((change) => change.node.id);
      expect(ids).toEqual([...ids].sort(compareIds));
      expect(new Set(ids).size).toBe(ids.length);
      for (const change of changes) {
        switch (change.kind) {
          case "added":
            expect(headIds.get(change.node.id)).toBe(change.node);
            expect(change.node.level === "folder" || change.node.level === "package" || !baseIds.has(change.node.id)).toBe(true);
            break;
          case "removed":
            expect(baseIds.get(change.node.id)).toBe(change.node);
            break;
          case "altered":
            expect(change.before.id).toBe(change.node.id);
            expect(change.before.digest).not.toBe(change.node.digest);
            break;
          case "moved":
            expect(baseIds.get(change.from.id)).toBe(change.from);
            expect(headIds.get(change.node.id)).toBe(change.node);
            expect(change.from.id).not.toBe(change.node.id);
            expect(change.from.digest).toBe(change.node.digest);
            expect(change.from.level).toBe(change.node.level);
            break;
        }
      }
      for (const change of changes) {
        if (change.node.level === "package" || change.node.level === "folder") expect(change.kind).not.toBe("altered");
      }
    }
    expect([...seen].sort()).toEqual(["added", "altered", "moved", "removed"]);
  });
});

describe("contractsMoved", () => {
  const moved = (before: Record<string, string>, after: Record<string, string>) =>
    contractsMoved(compareTrees(before, after)).map((move) => {
      const sides = `${move.before ?? "-"} => ${move.after ?? "-"}`;
      return `${move.kind} ${move.id}${move.from === undefined ? "" : ` <- ${move.from}`}: ${sides}`;
    });

  test("a changed signature of an exported function", () => {
    expect(
      moved(
        { "a.ts": "export function f(a: string): void {}\nexport function same(a) {}\n" },
        { "a.ts": "export function f(a: string, b: number): void {}\nexport function same(a) {}\n" },
      ),
    ).toEqual(["changed function:a.ts#f: (a: string): void => (a: string, b: number): void"]);
  });

  test("a changed body, a reformatting and a private function are not contracts moved", () => {
    expect(
      moved(
        { "a.ts": "export function f(a: string) { return 1; }\nfunction p(a) {}\n" },
        { "a.ts": "export function f(\n  a:   string, // renamed nothing\n) { return 2; }\nfunction p(a, b) {}\n" },
      ),
    ).toEqual([]);
  });

  test("a changed public method of an exported class changes the class's signature", () => {
    expect(
      moved(
        { "a.js": "export class A { m(a) {} n() {} }\n" },
        { "a.js": "export class A { m(a, b) {} n() {} }\n" },
      ),
    ).toEqual(["changed class:a.js#A: { m(a); n() } => { m(a, b); n() }"]);
  });

  test("an exported function added, and one removed with its file", () => {
    expect(
      moved(
        { "a.js": "export function old() {}\n", "gone.js": "export function bye(a) {}\nfunction local() {}\n" },
        { "a.js": "export function old() {}\nexport function fresh(x) {}\n", "new.js": "export class K {}\nfunction hidden() {}\n" },
      ),
    ).toEqual([
      "added class:new.js#K: - => {}",
      "added function:a.js#fresh: - => (x)",
      "removed function:gone.js#bye: (a) => -",
    ]);
  });

  test("an export that stops being one, with the body untouched, and one that starts", () => {
    expect(
      moved(
        { "a.js": "function f(a) {}\nfunction g() {}\nexport { f };\n" },
        { "a.js": "function f(a) {}\nfunction g() {}\nexport { g };\n" },
      ),
    ).toEqual(["unexported function:a.js#f: (a) => -", "exposed function:a.js#g: - => ()"]);
  });

  test("an exported function moved to another file keeps its signature and says where from", () => {
    expect(
      moved(
        { "a.js": "export function f(a) { return a; }\n" },
        { "b.js": "export function f(a) { return a; }\n" },
      ),
    ).toEqual(["moved function:b.js#f <- function:a.js#f: (a) => (a)"]);
  });

  test("is sorted by id, and empty when nothing exported moved", () => {
    const result = contractsMoved(
      compareTrees(
        { "b.js": "export function z() {}\n", "a.js": "export function y() {}\n" },
        { "b.js": "export function z(q) {}\n", "a.js": "export function y(q) {}\n" },
      ),
    );
    expect(result.map((move) => move.id)).toEqual(["function:a.js#y", "function:b.js#z"]);
    expect(contractsMoved(compareTrees({ "a.js": "export function f() {}\n" }, { "a.js": "export function f() {}\n" }))).toEqual([]);
  });

  test("CommonJS exports count the same way", () => {
    expect(
      moved(
        { "a.js": "function f(a) {}\nmodule.exports = { f };\n" },
        { "a.js": "function f(a, b) {}\nmodule.exports = { f };\n" },
      ),
    ).toEqual(["changed function:a.js#f: (a) => (a, b)"]);
  });
});
