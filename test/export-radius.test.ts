import { describe, expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { fileWhy } from "../src/defining.ts";
import { extract } from "../src/extract/extract.ts";
import type { Graph, NodeId } from "../src/graph.ts";
import { exportRadiusOf } from "../src/importance.ts";
import { risksOf } from "../src/risks.ts";
import { testChanges } from "../src/test-changes.ts";
import { isTestFile } from "../src/test-files.ts";

const treeOf = (files: Record<string, string>): Map<string, string> => new Map(Object.entries({ "package.json": "{}\n", ...files }));
const graphOf = (files: Record<string, string>): Graph => extract(treeOf(files));
const importsOf = (files: Record<string, string>, path: string): unknown =>
  graphOf(files)
    .imports.filter((edge) => edge.from === `file:${path}`)
    .map((edge) => [edge.specifier, edge.names, edge.reexports]);
const file = (path: string): NodeId => `file:${path}` as NodeId;
const radius = (files: Record<string, string>, path: string, of: readonly string[] | "all"): string[] =>
  exportRadiusOf(graphOf(files))(file(path), of)
    .map((id) => id.replace(/^file:/, ""))
    .sort();

describe("the extractor records the names an import takes", () => {
  test("named, default, aliased, namespace, side-effect and type imports", () => {
    expect(
      importsOf(
        {
          "a.ts":
            'import d, { x, y as z, type T } from "./m.ts";\nimport * as ns from "./n.ts";\nimport "./s.ts";\nimport type { Q } from "./q.ts";\nimport e from "./e.ts";\nexport const k = [d, x, z, ns, e];\n',
        },
        "a.ts",
      ),
    ).toEqual([
      ["./m.ts", ["T", "default", "x", "y"], undefined],
      ["./n.ts", "all", undefined],
      ["./s.ts", [], undefined],
      ["./q.ts", ["Q"], undefined],
      ["./e.ts", ["default"], undefined],
    ]);
  });

  test("require and import(): destructured names when literal, a property read, a bare statement; otherwise all", () => {
    expect(
      importsOf(
        {
          "a.js":
            'const { p, q: r } = require("./1.js");\nconst whole = require("./2.js");\nrequire("./3.js");\nconst v = require("./4.js").one;\nconst { ...rest } = require("./5.js");\nconst k = "z";\nconst { [k]: w } = require("./6.js");\nasync function load() {\n  const { s } = await import("./7.js");\n  import("./8.js");\n  return [s, p, r, whole, v, rest, w];\n}\n',
        },
        "a.js",
      ),
    ).toEqual([
      ["./1.js", ["p", "q"], undefined],
      ["./2.js", "all", undefined],
      ["./3.js", [], undefined],
      ["./4.js", ["one"], undefined],
      ["./5.js", "all", undefined],
      ["./6.js", "all", undefined],
      ["./7.js", ["s"], undefined],
      ["./8.js", [], undefined],
    ]);
  });

  test("re-exports record what they take and pass on", () => {
    expect(importsOf({ "i.ts": 'export { f, g as h } from "./a.ts";\nexport * from "./b.ts";\nexport * as c from "./c.ts";\nexport { default } from "./d.ts";\n' }, "i.ts")).toEqual([
      [
        "./a.ts",
        ["f", "g"],
        [
          { name: "f", as: "f" },
          { name: "g", as: "h" },
        ],
      ],
      ["./b.ts", "all", "star"],
      ["./c.ts", "all", [{ name: "*", as: "c" }]],
      ["./d.ts", ["default"], [{ name: "default", as: "default" }]],
    ]);
  });

  test("an exported block records the names it is exported under", () => {
    const g = graphOf({
      "m.ts": "export function a() {}\nfunction b() {}\nexport { b as c };\nexport default function () {}\nexport const d = () => 1;\n",
      "cjs.js": "exports.e = function () {};\nfunction f() {}\nmodule.exports.g = f;\n",
      "all.js": "module.exports = { h() {} };\n",
    });
    const as = (path: string): Record<string, unknown> =>
      Object.fromEntries(g.nodes.flatMap((n) => (n.level === "function" && n.path === path && n.exported ? [[n.qualifiedName, n.exportedAs]] : [])));
    expect(as("m.ts")).toEqual({ a: ["a"], b: ["c"], default: ["default"], d: ["d"] });
    expect(as("cjs.js")).toEqual({ '"exports.e"': ["e"], f: ["g"] });
    expect(as("all.js")).toEqual({ '"module.exports.h"': ["*"] });
  });
});

describe("exportRadiusOf", () => {
  const files = {
    "core.ts": "export const f = 1;\nexport const g = 2;\nexport default 3;\n",
    "uses-f.ts": 'import { f } from "./core.ts";\nexport const u = f;\n',
    "uses-g.ts": 'import { g as gg } from "./core.ts";\nexport const v = gg;\n',
    "ns.ts": 'import * as core from "./core.ts";\nexport const w = core;\n',
    "side.ts": 'import "./core.ts";\n',
    "top-f.ts": 'import { u } from "./uses-f.ts";\nexport const t = u;\n',
    "top-g.ts": 'import { v } from "./uses-g.ts";\nexport const t = v;\n',
  };

  test("a name's dependents are the files that import it, or all of it, and their own dependents; a side-effect import takes none", () => {
    expect(radius(files, "core.ts", ["f"])).toEqual(["ns.ts", "top-f.ts", "uses-f.ts"]);
    expect(radius(files, "core.ts", ["g"])).toEqual(["ns.ts", "top-g.ts", "uses-g.ts"]);
    expect(radius(files, "core.ts", ["nothing"])).toEqual(["ns.ts"]);
  });

  test("all names is every file that rests on the file", () => {
    expect(radius(files, "core.ts", "all")).toEqual(["ns.ts", "side.ts", "top-f.ts", "top-g.ts", "uses-f.ts", "uses-g.ts"]);
  });

  test("a re-export passes on only the names it re-exports, under the name it gives them", () => {
    const tree = {
      "core.ts": "export const f = 1;\nexport const g = 2;\n",
      "index.ts": 'export { f as ff } from "./core.ts";\n',
      "wants-ff.ts": 'import { ff } from "./index.ts";\nexport const a = ff;\n',
      "wants-f.ts": 'import { f } from "./index.ts";\nexport const b = f;\n',
      "deep.ts": 'import { a } from "./wants-ff.ts";\nexport const c = a;\n',
    };
    expect(radius(tree, "core.ts", ["f"])).toEqual(["deep.ts", "index.ts", "wants-ff.ts"]);
    expect(radius(tree, "core.ts", ["g"])).toEqual([]);
  });

  test("export * passes every name but default; export * as ns passes the module as ns; cycles end", () => {
    const tree = {
      "core.ts": "export const f = 1;\nexport default 2;\n",
      "a.ts": 'export * from "./core.ts";\nexport * from "./b.ts";\n',
      "b.ts": 'export * from "./a.ts";\n',
      "uses.ts": 'import { f } from "./b.ts";\nexport const x = f;\n',
      "uses-default.ts": 'import d from "./b.ts";\nexport const y = d;\n',
      "named.ts": 'export * as lib from "./core.ts";\n',
      "uses-lib.ts": 'import { lib } from "./named.ts";\nexport const z = lib;\n',
      "uses-other.ts": 'import { other } from "./named.ts";\nexport const z = other;\n',
    };
    expect(radius(tree, "core.ts", ["f"])).toEqual(["a.ts", "b.ts", "named.ts", "uses-lib.ts", "uses.ts"]);
    expect(radius(tree, "core.ts", ["default"])).toEqual(["named.ts", "uses-lib.ts"]);
  });

  test("a dynamic import of the whole module depends on every export; one that names its use depends on that", () => {
    const tree = {
      "core.js": "exports.f = 1;\nexports.g = 2;\n",
      "lazy.js": 'export const load = () => import("./core.js");\n',
      "picky.js": 'const { f } = require("./core.js");\nexports.p = f;\n',
    };
    expect(radius(tree, "core.js", ["g"])).toEqual(["lazy.js"]);
    expect(radius(tree, "core.js", ["f"])).toEqual(["lazy.js", "picky.js"]);
  });
});

describe("risks and defining blocks use the per-export radius", () => {
  const baseFiles = {
    "src/core.ts": "export function f(a) {\n  return a;\n}\nexport function g(a) {\n  return a;\n}\nfunction hidden() {\n  return 1;\n}\n",
    "src/uses-f.ts": 'import { f } from "./core.ts";\nexport const u = f;\n',
    "src/uses-g.ts": 'import { g } from "./core.ts";\nexport const v = g;\n',
    "src/top-g.ts": 'import { v } from "./uses-g.ts";\nexport const t = v;\n',
  };
  const base = treeOf(baseFiles);
  const head = treeOf({ ...baseFiles, "src/core.ts": baseFiles["src/core.ts"].replace("function f(a)", "function f(a, b)").replace("return 1;", "return 2;") });
  const [baseGraph, headGraph] = [extract(base), extract(head)];
  const comparison = compare(baseGraph, headGraph, { base, head });

  test("a changed export's blast is the files that import that name, not every file that imports the file", () => {
    const items = risksOf(comparison, baseGraph, headGraph, testChanges(base, head), isTestFile).filter((item) => item.kind === "contract");
    expect(items.map((item) => [item.label, item.blast.files])).toEqual([["f signature changed", ["src/uses-f.ts"]]]);
  });

  test("an exported block lists the files resting on it; the file keeps its whole list; an unexported block has none", () => {
    const found = fileWhy(file("src/core.ts"), comparison, baseGraph, headGraph, isTestFile)!;
    expect(found.why.dependents).toEqual(["src/top-g.ts", "src/uses-f.ts", "src/uses-g.ts"]);
    expect(found.defining.map((block) => [block.label, block.rests])).toEqual([["f", ["src/uses-f.ts"]]]);
    expect(found.other.map((block) => [block.label, block.rests])).toEqual([["hidden", undefined]]);
  });
});
