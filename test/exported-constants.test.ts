import { expect, test } from "vitest";
import { compare, contractsMoved } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { CodeNode, FileTree, NodeId } from "../src/graph.ts";
import { exportRadiusOf } from "../src/importance.ts";
import { risksOf } from "../src/risks.ts";
import { testChanges } from "../src/test-changes.ts";
import { isTestFile } from "../src/test-files.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries({ "package.json": "{}\n", ...files }));

function moves(base: string, head: string, path = "src/c.ts") {
  const [baseGraph, headGraph] = [extract(tree({ [path]: base })), extract(tree({ [path]: head }))];
  const comparison = compare(baseGraph, headGraph);
  return { comparison, moves: contractsMoved(comparison, baseGraph, headGraph).map((move) => ({ kind: move.kind, id: move.id, before: move.before, after: move.after })) };
}

const constants = (text: string, path = "src/c.ts"): CodeNode[] =>
  extract(tree({ [path]: text })).nodes.filter((node): node is CodeNode => node.level === "constant");

test("an added exported constant is a contract move, with its declared type as the signature", () => {
  const result = moves("export const a = 1;\n", 'export const a = 1;\nexport const UNTRUSTED_GIT: readonly string[] = ["a"];\n');
  expect(result.moves).toEqual([{ kind: "added", id: "constant:src/c.ts#UNTRUSTED_GIT", before: null, after: "readonly string[]" }]);
});

test("a removed exported constant is a contract move", () => {
  const result = moves('export const A = "x";\nexport const B = 2;\n', 'export const A = "x";\n');
  expect(result.moves).toEqual([{ kind: "removed", id: "constant:src/c.ts#B", before: "2", after: null }]);
});

test("a changed literal value is a signature change, text as written", () => {
  const result = moves('export const MODE = "fast";\nexport const N = 10;\n', "export const MODE = 'slow';\nexport const N = 10;\n");
  expect(result.moves).toEqual([{ kind: "changed", id: "constant:src/c.ts#MODE", before: '"fast"', after: "'slow'" }]);
});

test("a changed type annotation is a signature change, whatever the value", () => {
  const result = moves("export const x: number = 1;\n", "export const x: string | number = 1;\n");
  expect(result.moves).toEqual([{ kind: "changed", id: "constant:src/c.ts#x", before: "number", after: "string | number" }]);
});

test("a change inside a non-literal initializer is an altered block and no contract move", () => {
  const result = moves("export const cfg = { a: 1, b: load() };\nexport const t = make(1);\n", "export const cfg = { a: 2, b: load() };\nexport const t = make(2);\n");
  expect(result.moves).toEqual([]);
  expect(result.comparison.changes.filter((change) => change.node.level === "constant").map((change) => `${change.kind} ${change.node.id}`).sort()).toEqual(["altered constant:src/c.ts#cfg", "altered constant:src/c.ts#t"]);
});

test("the signature reads: annotation, then literal, then as-const text, then the kind of initializer", () => {
  const found = constants(
    [
      "export const a: Foo = make();",
      "export const b = `plain`;",
      "export const c = -3;",
      "export const d = /x+/g;",
      "export const e = 5n;",
      "export const f = null;",
      "export const g = true;",
      "export const h = { b: 1,  a: [1, 2], } as const;",
      "export const i = [ 'x',\n 'y' ] as const;",
      "export const j = { a: 1 };",
      "export const k = [1];",
      "export const l = make();",
      "export const m = new Map();",
      "export const n = `x${y}`;",
      "export let o;",
      "",
    ].join("\n"),
  );
  expect(Object.fromEntries(found.map((node) => [node.name, node.signature]))).toEqual({
    a: "Foo",
    b: "`plain`",
    c: "-3",
    d: "/x+/g",
    e: "5n",
    f: "null",
    g: "true",
    h: "{ b: 1, a: [1, 2] }",
    i: "['x', 'y']",
    j: "object",
    k: "array",
    l: "call",
    m: "new",
    n: "template",
    o: "uninitialised",
  });
  expect(found.every((node) => node.exported)).toBe(true);
});

test("as-const text ignores layout and comments", () => {
  const a = constants("export const h = { a: 1, b: 2 } as const;\n");
  const b = constants("export const h = {\n  // note\n  a: 1,\n  b: 2,\n} as const;\n");
  expect(b[0]!.signature).toBe(a[0]!.signature);
});

test("a function or arrow assigned to an export stays a function, and is not counted twice", () => {
  const graph = extract(tree({ "src/c.ts": "export const f = () => 1;\nexport const g = function () {};\nexport const K = 1;\n" }));
  expect(graph.nodes.filter((node) => node.level === "function").map((node) => node.id)).toEqual(["function:src/c.ts#f", "function:src/c.ts#g"]);
  expect(graph.nodes.filter((node) => node.level === "constant").map((node) => node.id)).toEqual(["constant:src/c.ts#K"]);
});

test("CommonJS exports.X and module.exports.X of a non-function value are constants", () => {
  const base = 'exports.NAME = "a";\nmodule.exports.LIST = [1];\nexports.fn = function () {};\n';
  const found = constants(base, "src/c.js");
  expect(found.map((node) => [node.name, node.signature, node.exportedAs])).toEqual([
    ["exports.NAME", '"a"', ["NAME", "default"]],
    ["module.exports.LIST", "array", ["LIST", "default"]],
  ]);
  const result = moves(base, base.replace('"a"', '"b"'), "src/c.js");
  expect(result.moves).toEqual([{ kind: "changed", id: 'constant:src/c.js#"exports.NAME"', before: '"a"', after: '"b"' }]);
});

test("export { x } of a local variable exports it under that name", () => {
  const found = constants("const x = 1;\nconst y = 2;\nexport { x, y as z };\n");
  expect(found.map((node) => [node.name, node.exported, node.exportedAs])).toEqual([
    ["x", true, ["x"]],
    ["y", true, ["z"]],
  ]);
  const result = moves("const x = 1;\nexport { x };\n", "const x = 2;\nexport { x };\n");
  expect(result.moves).toMatchObject([{ kind: "changed", before: "1", after: "2" }]);
});

test("a constant that is not exported is not a node", () => {
  expect(constants("const a = 1;\nlet b = 2;\n")).toEqual([]);
});

test("blast radius per export reaches an importer of an exported constant by name", () => {
  const files = (value: string): Record<string, string> => ({
    "core.ts": `export const LIMIT = ${value};\nexport const OTHER = 1;\n`,
    "uses-limit.ts": 'import { LIMIT } from "./core.ts";\nexport const u = LIMIT;\n',
    "uses-other.ts": 'import { OTHER } from "./core.ts";\nexport const v = OTHER;\n',
  });
  const [base, head] = [tree(files("1")), tree(files("2"))];
  const [baseGraph, headGraph] = [extract(base), extract(head)];
  expect(exportRadiusOf(headGraph)("file:core.ts" as NodeId, ["LIMIT"])).toEqual(["file:uses-limit.ts"]);
  const items = risksOf(compare(baseGraph, headGraph, { base, head }), baseGraph, headGraph, testChanges(base, head), isTestFile);
  const contract = items.filter((item) => item.kind === "contract");
  expect(contract).toHaveLength(1);
  expect(contract[0]!.blast.files).toEqual(["uses-limit.ts"]);
});
