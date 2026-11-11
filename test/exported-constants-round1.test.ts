import { expect, test } from "vitest";
import { compare, contractsMoved } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { CodeNode, FileTree } from "../src/graph.ts";
import { risksOf } from "../src/risks.ts";
import { testChanges } from "../src/test-changes.ts";
import { isTestFile } from "../src/test-files.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries({ "package.json": "{}\n", ...files }));

function moves(base: string, head: string, path = "src/c.ts") {
  const [baseGraph, headGraph] = [extract(tree({ [path]: base })), extract(tree({ [path]: head }))];
  const comparison = compare(baseGraph, headGraph);
  return { moves: contractsMoved(comparison, baseGraph, headGraph).map((move) => ({ kind: move.kind, id: move.id, before: move.before, after: move.after })) };
}

const constants = (text: string, path = "src/c.ts"): CodeNode[] =>
  extract(tree({ [path]: text })).nodes.filter((node): node is CodeNode => node.level === "constant");

test("a constant never changes the identity of an existing function with the same name", () => {
  const graph = extract(tree({ "a.ts": 'export const X = [function X() { return fetch("/"); }];\n' }));
  const code = graph.nodes.filter((node) => node.level === "constant" || node.level === "function" || node.level === "class");
  expect(code.map((node) => node.id).sort()).toEqual(["constant:a.ts#X", "function:a.ts#X"]);
  const effect = graph.edges.find((edge) => edge.kind === "effect");
  expect(effect?.from).toBe("function:a.ts#X");
});

test("losing an export name is a contract move, for a constant and for a function", () => {
  const constant = moves("const x = 1;\nexport { x as A, x as B };\n", "const x = 1;\nexport { x as A };\n");
  expect(constant.moves).toEqual([{ kind: "removed", id: "constant:src/c.ts#x", before: "1", after: null }]);
  const fn = moves("function f() {}\nexport { f as A, f as B };\n", "function f() {}\nexport { f as A };\n");
  expect(fn.moves.map((move) => move.kind)).toEqual(["removed"]);
  const added = moves("function f() {}\nexport { f as A };\n", "function f() {}\nexport { f as A, f as B };\n");
  expect(added.moves.map((move) => move.kind)).toEqual(["added"]);
});

test("a lost export name reaches the importers of that name", () => {
  const files = (exportList: string): Record<string, string> => ({
    "core.ts": `const x = 1;\n${exportList}\n`,
    "uses-b.ts": 'import { B } from "./core.ts";\nexport const u = B;\n',
  });
  const [base, head] = [tree(files("export { x as A, x as B };")), tree(files("export { x as A };"))];
  const [baseGraph, headGraph] = [extract(base), extract(head)];
  const items = risksOf(compare(baseGraph, headGraph, { base, head }), baseGraph, headGraph, testChanges(base, head), isTestFile);
  expect(items.filter((item) => item.kind === "contract").map((item) => item.blast.files)).toEqual([["uses-b.ts"]]);
});

test("a constant that re-exports a local is the one contract, not two", () => {
  const result = moves("", "const local = 1;\nexport const X = local;\n");
  expect(result.moves).toEqual([{ kind: "added", id: "constant:src/c.ts#X", before: null, after: "identifier" }]);
});

test("CommonJS exports.X of any non-function value is a constant, an identifier included", () => {
  const found = constants("exports.X = 1;\nexports.Y = undefined;\nexports.Z = other;\nconst k = 2;\nexports.W = k;\n", "src/c.js");
  expect(found.map((node) => [node.name, node.signature]).sort()).toEqual([
    ["exports.W", "identifier"],
    ["exports.X", "1"],
    ["exports.Y", "identifier"],
    ["exports.Z", "identifier"],
  ]);
  const result = moves("exports.X = 1;\n", "exports.X = undefined;\n", "src/c.js");
  expect(result.moves).toEqual([{ kind: "changed", id: 'constant:src/c.js#"exports.X"', before: "1", after: "identifier" }]);
});

test("as const is found under satisfies, parentheses and assertions", () => {
  const result = moves("export const A = { a: 1 } as const satisfies object;\n", "export const A = ({ a: 2 } as const) satisfies object;\n");
  expect(result.moves).toEqual([{ kind: "changed", id: "constant:src/c.ts#A", before: "{ a: 1 }", after: "{ a: 2 }" }]);
});

test("what cannot be read as a literal falls back to its text, not to a coarse kind", () => {
  const result = moves("export const A = flag ? 1 : 2;\nexport const B = `x${y}`;\nexport const C = {} as Foo;\n", "export const A = flag ? 1 : 3;\nexport const B = `x${z}`;\nexport const C = {} as Bar;\n");
  expect(result.moves.map((move) => [move.before, move.after])).toEqual([
    ["flag ? 1 : 2", "flag ? 1 : 3"],
    ["`x${ y }`", "`x${ z }`"],
    ["Foo", "Bar"],
  ]);
});

test("destructured exports are constants, one per bound name", () => {
  const found = constants("export const { X, y: Y, ...rest } = { X: 1, y: 2 };\nexport const [P, [Q]]: number[] = [];\n");
  expect(found.map((node) => [node.name, node.signature, node.exportedAs]).sort()).toEqual([
    ["P", "number[]", ["P"]],
    ["Q", "number[]", ["Q"]],
    ["X", "destructured", ["X"]],
    ["Y", "destructured", ["Y"]],
    ["rest", "destructured", ["rest"]],
  ]);
});

test("an array hole is not a trailing comma", () => {
  const sig = (text: string): string => constants(`export const h = ${text} as const;\n`)[0]!.signature;
  expect(sig("[]")).not.toBe(sig("[,]"));
  expect(sig("[1,,]")).not.toBe(sig("[1,]"));
  expect(sig("[1,]")).toBe(sig("[1]"));
});
