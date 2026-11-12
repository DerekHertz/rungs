import { expect, test } from "vitest";
import { compare, contractsMoved, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { contractsReport, unmentioned, unmentionedIds } from "../src/review.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const pkg = { "package.json": "{}\n" };

function report(base: Record<string, string>, head: Record<string, string>) {
  const headGraph = extract(tree(head));
  const baseGraph = extract(tree(base));
  const comparison = compare(baseGraph, headGraph);
  const claims = unmentioned(comparison, pictureOf(headGraph, comparison).graph, "");
  return contractsReport(comparison, contractsMoved(comparison, baseGraph, headGraph), unmentionedIds(claims), headGraph);
}
const one = (base: string, head: string, file = "src/t.ts"): string[] =>
  report({ ...pkg, [file]: base }, { ...pkg, [file]: head }).entries.map((entry) => (entry.kind === "row" ? `${entry.move.kind} ${entry.label}` : "rollup"));
const types = (text: string, file = "src/t.ts") => {
  const node = extract(tree({ ...pkg, [file]: text })).nodes.find((n) => n.level === "file" && n.path === file);
  return node !== undefined && "types" in node ? node.types : undefined;
};

test("an ambient namespace's interface is a contract, whether exported with export = or export { }", () => {
  expect(one("declare namespace API { interface A { x: 1 } }\nexport = API;\n", "declare namespace API { interface A { x: 2 } }\nexport = API;\n", "src/api.d.ts")).toEqual(["changed A"]);
  expect(one("declare namespace API { interface A { x: 1 } }\nexport { API };\n", "declare namespace API { interface A { x: 2 } }\nexport { API };\n", "src/api.d.ts")).toEqual(["changed API.A"]);
  expect(one("declare namespace API { interface A { x: 1 } }\nexport { API as Api };\n", "declare namespace API { interface A { x: 2 } }\nexport { API as Api };\n", "src/api.d.ts")).toEqual(["changed Api.A"]);
  expect(one("declare namespace API { interface A { x: 1 } }\nexport default API;\n", "declare namespace API { interface A { x: 2 } }\nexport default API;\n", "src/api.d.ts")).toEqual(["changed default.A"]);
  expect(one("namespace API { export interface A { x: 1 } }\nexport { API };\n", "namespace API { export interface A { x: 2 } }\nexport { API };\n")).toEqual(["changed API.A"]);
});

test("a plain ambient namespace in a declaration file is a contract", () => {
  expect(one("declare namespace API { interface A { x: 1 } }\n", "declare namespace API { interface A { x: 2 } }\n", "src/api.d.ts")).toEqual(["changed API.A"]);
  // In a module file, a namespace nobody exports is private.
  expect(one("export {};\ndeclare namespace API { interface A { x: 1 } }\n", "export {};\ndeclare namespace API { interface A { x: 2 } }\n")).toEqual([]);
});

test("a namespace declared twice keeps the members of both blocks", () => {
  const first = "export namespace API { export interface A { x: 1 } }\nexport namespace API { export interface B { y: 1 } }\n";
  expect(one(first, first.replace("x: 1", "x: 2"))).toEqual(["changed API.A"]);
  expect(one(first, first.replace("y: 1", "y: 2"))).toEqual(["changed API.B"]);
  const merged = "export namespace API { export interface A { x: 1 } }\nexport namespace API { export interface A { y: 1 } }\n";
  expect(one(merged, merged.replace("x: 1", "x: 2"))).toEqual(["changed API.A"]);
  expect(one(merged, merged.replace("y: 1", "y: 2"))).toEqual(["changed API.A"]);
});

test("formatting is no change in mapped types and tuples", () => {
  expect(one("export type A = { [K in keyof T]: T[K]; };\n", "export type A = { [K in keyof T]: T[K] };\n")).toEqual([]);
  expect(one("export type A = { [K in keyof T]: T[K] };\n", "export type A = {\n  [K in keyof T]: T[K]\n};\n")).toEqual([]);
  expect(one("export type A = { readonly [K in keyof T]?: T[K]; };\n", "export type A = { readonly [K in keyof T]?: T[K] };\n")).toEqual([]);
  expect(one("export type A = [string, number,];\n", "export type A = [string, number];\n")).toEqual([]);
  expect(one("export type A = [\n  string,\n  number,\n];\n", "export type A = [string, number];\n")).toEqual([]);
  expect(one("export interface I { m: { [K in keyof T]: T[K]; }; t: [a: string, b?: number,] }\n", "export interface I { m: { [K in keyof T]: T[K] }; t: [a: string, b?: number] }\n")).toEqual([]);
  // A real change still shows.
  expect(one("export type A = [string, number];\n", "export type A = [string, number, boolean];\n")).toEqual(["changed A"]);
  expect(one("export type A = { [K in keyof T]: T[K] };\n", "export type A = { [K in keyof T]?: T[K] };\n")).toEqual(["changed A"]);
});

test("consolidating interface extends clauses is no change", () => {
  expect(one("export interface A extends X {}\nexport interface A extends Y {}\n", "export interface A extends X, Y {}\n")).toEqual([]);
  expect(one("export interface A extends X, Y {}\n", "export interface A extends Y, X {}\n")).toEqual([]);
  expect(one("export interface A extends X {}\n", "export interface A extends X, Y {}\n")).toEqual(["changed A"]);
});

test("an imported type re-exported through export type { A } is recorded", () => {
  expect(one("import type { A } from './x';\nexport type { A };\n", "import type { A } from './y';\nexport type { A };\n")).toEqual(["changed A"]);
  expect(one("export {};\n", "import type { A } from './x';\nexport type { A };\n")).toEqual(["added A"]);
  expect(one("import { type A } from './x';\nexport { type A };\n", "export {};\n")).toEqual(["removed A"]);
  expect(one("import type { A as B } from './x';\nexport type { B as C };\n", "import type { A as B } from './x';\nexport type { B as C };\n")).toEqual([]);
  // A name that is not declared or imported here is not guessed.
  expect(types("export type { Z };\n")).toEqual([]);
});

test("reordering interface members stays a change (left as is)", () => {
  expect(one("export interface A { x: 1; y: 2 }\n", "export interface A { y: 2; x: 1 }\n")).toEqual(["changed A"]);
});

test("a binary-marked code file goes through no language adapter", () => {
  const text = "//\0\nexport function f() { return 1; }\nfetch('x');\n";
  const graph = extract(tree({ ...pkg, "a.ts": text, "b.js": "\0module.exports = function g() {};\n" }));
  expect(graph.nodes.filter((n) => n.level !== "file" && n.level !== "folder" && n.level !== "package")).toEqual([]);
  expect(graph.edges).toEqual([]);
  expect(graph.imports).toEqual([]);
  expect(graph.resolutions).toEqual([]);
  const file = graph.nodes.find((n) => n.level === "file" && n.path === "a.ts");
  expect(file).toMatchObject({ lines: null, analysis: "not analysed" });
  expect(file !== undefined && "types" in file).toBe(false);
});
