import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compare, contractsMoved, ExtractorVersionMismatch, serializeComparison, tally } from "../src/compare.ts";
import { effectLabel } from "../src/effects.ts";
import type { Comparison, ModuleChange } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { compareIds } from "../src/graph.ts";
import type { CodeNode, FileTree, Graph, NodeId } from "../src/graph.ts";
import { withholdUnread } from "../src/readable.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const fixtureUrl = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const goldenPath = fileURLToPath(new URL("golden/compare.json", import.meta.url));

const { base, head, unread } = withholdUnread(extract(readFixtureTree(fixtureUrl("small"))), extract(readFixtureTree(fixtureUrl("small-head"))));
const comparison = compare(base, head, undefined, unread);

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
const withGraphs = (before: Record<string, string>, after: Record<string, string>) => {
  const baseGraph = extract(treeOf(before));
  const headGraph = extract(treeOf(after));
  return [compare(baseGraph, headGraph), baseGraph, headGraph] as const;
};
const IMPORT = 'import { spawn } from "node:child_process";\n';
const withImport = (code: string): string => IMPORT + code;

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
      "package:": "+7 ~4 -3 >1",
      "folder:docs": "+2 ~0 -1 >0",
      "folder:src": "+3 ~4 -1 >1",
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
      resolutions: [],
      imports: [],
      sections: [],
      manifests: [],
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
    resolutions: [],
    imports: [],
    sections: [],
    manifests: [],
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
    contractsMoved(...withGraphs(before, after)).map((move) => {
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
      ...withGraphs(
        { "b.js": "export function z() {}\n", "a.js": "export function y() {}\n" },
        { "b.js": "export function z(q) {}\n", "a.js": "export function y(q) {}\n" },
      ),
    );
    expect(result.map((move) => move.id)).toEqual(["function:a.js#y", "function:b.js#z"]);
    expect(contractsMoved(...withGraphs({ "a.js": "export function f() {}\n" }, { "a.js": "export function f() {}\n" }))).toEqual([]);
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

describe("effect changes", () => {
  const effects = (before: Record<string, string>, after: Record<string, string>) =>
    compareTrees(before, after).effects.map((change) => {
      const owner = change.edge.from.slice(change.edge.from.indexOf(":") + 1);
      return `${change.kind} ${owner} ${effectLabel(change.edge)}`;
    });

  test("a new call in an altered function is added, and a dropped one is removed", () => {
    expect(
      effects(
        { "a.mjs": withImport("export function f() {\n  return 1;\n}\n") },
        { "a.mjs": withImport('export function f() {\n  spawn("git");\n}\n') },
      ),
    ).toEqual(['added a.mjs#f process child_process spawn "git"']);
    expect(
      effects(
        { "a.mjs": withImport('export function f() {\n  spawn("git");\n}\n') },
        { "a.mjs": withImport("export function f() {\n  return 1;\n}\n") },
      ),
    ).toEqual(['removed a.mjs#f process child_process spawn "git"']);
  });

  test("a line shift alone changes nothing", () => {
    const code = 'export function f() {\n  spawn("git");\n}\n';
    expect(effects({ "a.mjs": withImport(code) }, { "a.mjs": `// new\n${withImport(code)}` })).toEqual([]);
  });

  test("a function moved with its body keeps its edges, at top level too", () => {
    const code = 'spawn("top");\nexport function f() {\n  spawn("git");\n}\n';
    expect(effects({ "a.mjs": withImport(code) }, { "lib/b.mjs": withImport(code) })).toEqual([]);
  });

  test("the same call twice then three times is one new edge", () => {
    const call = '  spawn("git");\n';
    expect(
      effects(
        { "a.mjs": withImport(`export function f() {\n${call}${call}}\n`) },
        { "a.mjs": withImport(`export function f() {\n${call}${call}${call}}\n`) },
      ),
    ).toEqual(['added a.mjs#f process child_process spawn "git"']);
  });

  test("an import that starts to resolve adds the edge though the function's text is the same", () => {
    const fn = 'export function f() {\n  spawn("git");\n}\n';
    const result = compareTrees(
      { "a.mjs": `import { spawn } from "./local.js";\n${fn}` },
      { "a.mjs": `import { spawn } from "node:child_process";\n${fn}` },
    );
    expect(result.changes.map((change) => change.node.id)).toEqual(["file:a.mjs"]);
    expect(result.effects.map((change) => `${change.kind} ${effectLabel(change.edge)}`)).toEqual([
      'added process child_process spawn "git"',
    ]);
  });

  test("an added file's top-level effect is added to the file, a removed file's is removed", () => {
    expect(effects({ "x.js": "1\n" }, { "x.js": "1\n", "a.mjs": withImport('spawn("git");\n') })).toEqual([
      'added a.mjs process child_process spawn "git"',
    ]);
    expect(effects({ "x.js": "1\n", "a.mjs": withImport('spawn("git");\n') }, { "x.js": "1\n" })).toEqual([
      'removed a.mjs process child_process spawn "git"',
    ]);
  });

  test("the comparison's effects are sorted and serialized with the changes", () => {
    const result = compareTrees({ "x.js": "1\n" }, { "x.js": "1\n", "b.mjs": withImport('spawn("b");\n'), "a.mjs": withImport('spawn("a");\n') });
    expect(result.effects.map((change) => change.edge.from)).toEqual(["file:a.mjs", "file:b.mjs"]);
    const parsed = JSON.parse(serializeComparison(result)) as { effects: { kind: string; edge: { operation: string } }[] };
    expect(parsed.effects.map((change) => `${change.kind} ${change.edge.operation}`)).toEqual([
      "added child_process spawn",
      "added child_process spawn",
    ]);
  });
});

describe("contractsMoved with effects", () => {
  const moves = (before: Record<string, string>, after: Record<string, string>) => {
    const baseGraph = extract(treeOf(before));
    const headGraph = extract(treeOf(after));
    return contractsMoved(compare(baseGraph, headGraph), baseGraph, headGraph).map((move) => {
      const e = move.effects;
      const effects = e === undefined ? "" : ` +[${e.added.join("; ")}] -[${e.removed.join("; ")}]`;
      return `${move.kind} ${move.id}${effects}`;
    });
  };
  const exported = (call: string): string => `export function f(a) {\n  ${call}\n}\n`;

  test("an exported function whose effect set changed under the same signature is an effects move", () => {
    expect(moves({ "a.mjs": withImport(exported("return 1;")) }, { "a.mjs": withImport(exported('spawn("git");')) })).toEqual([
      'effects function:a.mjs#f +[process child_process spawn "git"] -[]',
    ]);
    expect(moves({ "a.mjs": withImport(exported('spawn("git");')) }, { "a.mjs": withImport(exported("return 1;")) })).toEqual([
      'effects function:a.mjs#f +[] -[process child_process spawn "git"]',
    ]);
  });

  test("a changed signature carries the effect difference", () => {
    expect(
      moves(
        { "a.mjs": withImport(exported('spawn("a");')) },
        { "a.mjs": withImport(exported('spawn("b");').replace("(a)", "(a, b)")) },
      ),
    ).toEqual(['changed function:a.mjs#f +[process child_process spawn "b"] -[process child_process spawn "a"]']);
  });

  test("an unchanged set is no move, a closure inside counts, a private function and top level do not", () => {
    const same = withImport(exported('spawn("a");'));
    expect(moves({ "a.mjs": same }, { "a.mjs": same.replace("a)", "a) /* x */") })).toEqual([]);
    expect(
      moves(
        { "a.mjs": withImport("export function f() {\n  return () => 1;\n}\n") },
        { "a.mjs": withImport('export function f() {\n  return () => spawn("c");\n}\n') },
      ),
    ).toEqual(['effects function:a.mjs#f +[process child_process spawn "c"] -[]']);
    expect(
      moves(
        { "a.mjs": withImport("function p() {}\nexport function q() {}\n") },
        { "a.mjs": withImport('spawn("t");\nfunction p() { spawn("x"); }\nexport function q() {}\n') },
      ),
    ).toEqual([]);
  });

  test("an added exported function brings its set as added, a removed one as removed", () => {
    expect(moves({ "a.mjs": "const x = 1;\n" }, { "a.mjs": withImport(exported('spawn("g");')) })).toEqual([
      'added function:a.mjs#f +[process child_process spawn "g"] -[]',
    ]);
    expect(moves({ "a.mjs": withImport(exported('spawn("g");')) }, { "a.mjs": "const x = 1;\n" })).toEqual([
      'removed function:a.mjs#f +[] -[process child_process spawn "g"]',
    ]);
  });

  test("an import that starts to resolve moves the effect set of an exported function with the same text", () => {
    const fn = 'export function f() {\n  spawn("git");\n}\n';
    expect(
      moves(
        { "a.mjs": `import { spawn } from "./local.js";\n${fn}` },
        { "a.mjs": `import { spawn } from "node:child_process";\n${fn}` },
      ),
    ).toEqual(['effects function:a.mjs#f +[process child_process spawn "git"] -[]']);
  });
});
