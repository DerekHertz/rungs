import { expect, test } from "vitest";
import { compare, contractsMoved } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { CodeNode, FileTree, NodeId } from "../src/graph.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries({ "package.json": "{}\n", ...files }));

function moves(base: string, head: string, path: string) {
  const [baseGraph, headGraph] = [extract(tree({ [path]: base })), extract(tree({ [path]: head }))];
  const comparison = compare(baseGraph, headGraph);
  return contractsMoved(comparison, baseGraph, headGraph).map((move) => ({ kind: move.kind, id: move.id, before: move.before, after: move.after }));
}

const nodes = (text: string, path: string, level: string): CodeNode[] =>
  extract(tree({ [path]: text })).nodes.filter((node): node is CodeNode => node.level === level);

const constants = (text: string, path = "src/c.ts") => nodes(text, path, "constant").map((node) => [node.name, node.signature, node.exportedAs ?? null]);
const effects = (text: string, path = "src/c.js") =>
  extract(tree({ [path]: text })).edges.map((edge) => ({ operation: edge.operation, ...(edge.globalReassigned === undefined ? {} : { globalReassigned: edge.globalReassigned }) }));

// #43
test("CommonJS exports with a dot or empty key are exports, compared as key lists", () => {
  const base = "function f(x) {}\nexports['a.b'] = f;\n";
  expect(nodes(base, "src/c.js", "function").map((node) => [node.name, node.exportedAs])).toEqual([["f", ["a.b", "default"]]]);
  expect(moves(base, base.replace("f(x)", "f(x, y)"), "src/c.js")).toMatchObject([{ kind: "changed", id: "function:src/c.js#f" }]);
  expect(nodes("function g() {}\nmodule.exports['a.b'] = g;\nexports[''] = g;\n", "src/c.js", "function").map((node) => node.exportedAs)).toEqual([["", "a.b", "default"]]);
});

test("a dot or empty key keeps its constant apart from a nested access", () => {
  expect(constants('exports["a.b"] = 1;\nmodule.exports["c.d"] = 2;\nexports[""] = 3;\nexports.a.b = 4;\nexports.x["y"] = 5;\nmodule["exports.z"] = 6;\n', "src/c.js")).toEqual([
    ['exports[""]', "3", ["", "default"]],
    ['exports["a.b"]', "1", ["a.b", "default"]],
    ['module.exports["c.d"]', "2", ["c.d", "default"]],
  ]);
  expect(moves('exports["a.b"] = 1;\n', 'exports["a.b"] = 2;\n', "src/c.js")).toMatchObject([{ kind: "changed", before: "1", after: "2" }]);
});

test("a plain key through brackets keeps the identity it had", () => {
  expect(constants('exports["x"] = 1;\nexports["a-b"] = 2;\n', "src/c.js").map(([name]) => name)).toEqual(["exports.a-b", "exports.x"]);
});

// #151
test("a require made by createRequire resolves to the module", () => {
  const head = 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nconst fs = require("fs");\nfs.readFileSync("a");\n';
  expect(effects(head, "src/c.mjs").map((edge) => edge.operation)).toContain("fs readFileSync");
  expect(effects(head.replace("fs.readFileSync", "require('fs').readFileSync"), "src/c.mjs").map((edge) => edge.operation)).toContain("fs readFileSync");
  expect(
    effects('const { createRequire } = require("module");\nconst r = createRequire(import.meta.url);\nconst { writeFileSync } = r("fs");\nwriteFileSync("a", "b");\n', "src/c.cjs").map((edge) => edge.operation),
  ).toContain("fs writeFileSync");
});

test("an unrelated local createRequire still reaches nothing", () => {
  expect(effects('function createRequire() {}\nconst require = createRequire(import.meta.url);\nconst fs = require("fs");\nfs.readFileSync("a");\n', "src/c.mjs").map((edge) => edge.operation)).toEqual([]);
});

// #50
test("a global the file reassigns keeps its edge and says so", () => {
  for (const object of ["globalThis", "window", "global", "self"]) {
    expect(effects(`${object}.fetch = () => 1;\nexport function f() { fetch("url"); }\n`, "src/c.js")).toEqual([{ operation: "fetch", globalReassigned: true }]);
  }
  expect(effects('globalThis["fetch"] = () => 1;\nexport function f() { globalThis.fetch("url"); }\n')).toEqual([{ operation: "fetch", globalReassigned: true }]);
  expect(effects("globalThis.setTimeout = () => 1;\nexport function f() { setTimeout(g, 1); }\n")).toEqual([{ operation: "setTimeout", globalReassigned: true }]);
});

test("a global nobody reassigns carries no marker, and reassigning another name marks nothing", () => {
  expect(effects('export function f() { fetch("url"); }\n')).toEqual([{ operation: "fetch" }]);
  expect(effects('globalThis.other = 1;\nexport function f() { fetch("url"); }\n')).toEqual([{ operation: "fetch" }]);
  expect(effects('const o = {};\no.fetch = 1;\nexport function f() { fetch("url"); }\n')).toEqual([{ operation: "fetch" }]);
});

// #219
test("non-function properties of module.exports = { ... } are constants", () => {
  const base = "const k = 2;\nmodule.exports = { A: 1, B: [1], C: make(), 'd-e': 'x', f() {}, g: () => 1, k, H: other };\n";
  expect(constants(base, "src/c.js")).toEqual([
    ["module.exports{A}", "1", ["A", "default"]],
    ["module.exports{B}", "array", ["B", "default"]],
    ["module.exports{C}", "call", ["C", "default"]],
    ["module.exports{H}", "identifier", ["H", "default"]],
    ["module.exports{d-e}", "'x'", ["d-e", "default"]],
    ["k", "2", ["*"]],
  ]);
  expect(moves("module.exports = { A: 1 };\n", "module.exports = { A: 2 };\n", "src/c.js")).toMatchObject([{ kind: "changed", before: "1", after: "2" }]);
  expect(moves("module.exports = { A: 1 };\n", "module.exports = { A: 1, B: 2 };\n", "src/c.js")).toMatchObject([{ kind: "added", after: "2" }]);
  expect(moves("module.exports = { A: 1, B: 2 };\n", "module.exports = { A: 1 };\n", "src/c.js")).toMatchObject([{ kind: "removed", before: "2" }]);
});

test("export default of a value that is not a function is a constant named default", () => {
  expect(constants("export default 5;\n")).toEqual([["default", "5", ["default"]]]);
  expect(constants("export default { a: 1, m() {} };\n")).toEqual([["default", "object", ["default"]]]);
  expect(constants("export default make();\n")).toEqual([["default", "call", ["default"]]]);
  expect(constants("export default [1, 2] as const;\n")).toEqual([["default", "[1, 2]", ["default"]]]);
  expect(constants("export default function () {}\n")).toEqual([]);
  expect(constants("export default () => 1;\n")).toEqual([]);
  expect(constants("const x = 1;\nexport default x;\n")).toEqual([["x", "1", ["default"]]]);
  expect(moves("export default 5;\n", "export default 6;\n", "src/c.ts")).toMatchObject([{ kind: "changed", id: "constant:src/c.ts#default", before: "5", after: "6" }]);
});

test("export declare const is a constant with its declared type", () => {
  expect(constants("export declare const A: number;\nexport declare let b: string | null;\ndeclare const c: number;\n")).toEqual([
    ["A", "number", ["A"]],
    ["b", "string | null", ["b"]],
  ]);
  expect(moves("export declare const A: number;\n", "export declare const A: string;\n", "src/c.ts")).toMatchObject([{ kind: "changed", before: "number", after: "string" }]);
});

test("enums, const enums and namespaces are constants whose members are the signature", () => {
  expect(constants('export const enum E { A = 1, B, C = "x" }\nexport enum F { X }\nenum G { Y }\nexport declare enum H { Z }\n')).toEqual([
    ["E", 'const enum { A = 1, B, C = "x" }', ["E"]],
    ["F", "enum { X }", ["F"]],
    ["H", "enum { Z }", ["H"]],
  ]);
  expect(moves("export const enum E { A = 1 }\n", "export const enum E { A = 2 }\n", "src/c.ts")).toMatchObject([{ kind: "changed", id: "constant:src/c.ts#E" }]);
  expect(moves("export enum E { A }\n", "export enum E { A, B }\n", "src/c.ts")).toMatchObject([{ kind: "changed", id: "constant:src/c.ts#E" }]);
  expect(constants("enum G { Y }\nexport { G };\n")).toEqual([["G", "enum { Y }", ["G"]]]);
  const space = constants(
    "export namespace N {\n  export const a = 1;\n  export function f(x: number): string { return ''; }\n  const hidden = 2;\n  export class C<T> { m(): void {} }\n  export enum E { P }\n  export namespace M { export const z: string = 'a'; }\n  export interface I {}\n}\nnamespace Private { export const a = 1; }\nexport namespace Types { export interface I {} }\n",
  );
  expect(space).toEqual([["N", "namespace { const a = 1; function f(x: number): string; class C<T> { m(): void }; enum E { P }; namespace M { const z: string } }", ["N"]]]);
  expect(moves("export namespace N { export const a = 1; }\n", "export namespace N { export const a = 1; export const b = 2; }\n", "src/c.ts")).toMatchObject([{ kind: "changed", id: "constant:src/c.ts#N" }]);
});

test("no node that existed changes identity", () => {
  const ids = (text: string, path: string) => extract(tree({ [path]: text })).nodes.map((node) => node.id);
  expect(ids("export namespace N { export function f() {} }\nexport function g() {}\nexport default class {}\n", "src/c.ts")).toEqual(
    expect.arrayContaining(['function:src/c.ts#"N.f"', "function:src/c.ts#g", "class:src/c.ts#default"]),
  );
  expect(ids("module.exports = { f() {}, g: () => 1 };\n", "src/c.js")).toEqual(
    expect.arrayContaining(['function:src/c.js#"module.exports.f"', 'function:src/c.js#"module.exports.g"']),
  );
});

// Codex round 1
test("no node main produced changes its id, and a new node never takes an ordinal slot", () => {
  const files: Record<string, string> = {
    "a.js": "module.exports = { A: 1, f() {}, g: () => 1 };\nmodule.exports.A = 2;\nexports.A = 3;\nexports.f = function () {};\n",
    "b.ts": "export const A = 1;\nexport function f() {}\nexport default class {}\nexport namespace N { export function g() {} }\nexport const X = A;\nexport { A as B };\n",
    "c.js": "const k = 2;\nfunction h() {}\nmodule.exports = { k, h, m() {} };\nexports['x-y'] = 1;\n",
    "d.ts": "const x = 1;\nexport default x;\nexport const { p, q } = obj;\n",
  };
  // The ids extractor v19 gave these files.
  const main = ['constant:a.js#"exports.A"', 'constant:a.js#"module.exports.A"', 'function:a.js#"exports.f"', 'function:a.js#"module.exports.f"', 'function:a.js#"module.exports.g"', "class:b.ts#default", "constant:b.ts#A", "constant:b.ts#X", 'function:b.ts#"N.g"', "function:b.ts#f", 'constant:c.js#"exports.x-y"', "constant:c.js#k", 'function:c.js#"module.exports.m"', "function:c.js#h", "constant:d.ts#p", "constant:d.ts#q", "constant:d.ts#x"];
  const now = new Set(Object.entries(files).flatMap(([path, text]) => extract(tree({ [path]: text })).nodes.map((node) => node.id)));
  for (const id of main) expect(now.has(id as NodeId), id).toBe(true);
  const a = nodes(files["a.js"]!, "a.js", "constant").map((node) => [node.id, node.signature]);
  expect(a).toContainEqual(['constant:a.js#"module.exports.A"', "2"]);
  expect(a).toContainEqual(['constant:a.js#"module.exports{A}"', "1"]);
});

test("a bare assignment to a global marks it reassigned", () => {
  expect(effects('fetch = () => {};\nexport function f() { fetch("url"); }\n')).toEqual([{ operation: "fetch", globalReassigned: true }]);
  expect(effects('let fetch = 1;\nfetch = () => {};\nexport function f() { fetch("url"); }\n')).toEqual([]);
});

test("export default of a name or any expression is a constant, so changing it is a move, not a removal", () => {
  expect(constants("export default undefined;\n")).toEqual([["default", "identifier", ["default"]]]);
  expect(constants('import x from "./x";\nexport default x;\n')).toEqual([["default", "identifier", ["default"]]]);
  expect(constants("interface T {}\nexport default T;\n")).toEqual([]);
  expect(moves("export default 5;\n", "export default undefined;\n", "src/c.ts")).toMatchObject([{ kind: "changed", before: "5", after: "identifier" }]);
});

test("blocks of one namespace merge, in source order", () => {
  expect(constants("export namespace N { export const a = 1; }\nexport namespace N { export const b = 2; }\n")).toEqual([["N", "namespace { const a = 1; const b = 2 }", ["N"]]]);
  expect(moves("export namespace N { export const a = 1; }\nexport namespace N { export const b = 2; }\n", "export namespace N { export const a = 1; }\nexport namespace N { export const b = 3; }\n", "src/c.ts")).toMatchObject([{ kind: "changed", id: "constant:src/c.ts#N" }]);
  expect(constants("export namespace N { export namespace M { export const a = 1; } }\nexport namespace N { export namespace M { export const b = 2; } }\n")[0]![1]).toBe("namespace { namespace M { const a = 1; const b = 2 } }");
});

test("__proto__: value sets a prototype and exports nothing; a computed key is a property", () => {
  expect(constants("module.exports = { __proto__: null, A: 1, '__proto__': 2 };\n", "src/c.js").map(([name]) => name)).toEqual(["module.exports{A}"]);
  expect(constants("module.exports = { ['__proto__']: 1 };\n", "src/c.js").map(([name]) => name)).toEqual(["module.exports{__proto__}"]);
});

test("an ambient value is exported under an alias", () => {
  expect(constants("export declare const x: number;\nexport { x as y };\n")).toEqual([["x", "number", ["x", "y"]]]);
  expect(constants("declare const x: number;\nexport { x as y };\n")).toEqual([["x", "number", ["y"]]]);
});

// Codex round 2
test("a name bound by import type is a type, not a value", () => {
  expect(constants('import type { T } from "./types";\nexport default T;\n')).toEqual([]);
  expect(constants('import { type T } from "./types";\nexport default T;\n')).toEqual([]);
  expect(constants('import type T from "./types";\nexport default T;\n')).toEqual([]);
  expect(constants('import type * as T from "./types";\nexport default T;\n')).toEqual([]);
  expect(constants('import { T } from "./types";\nexport default T;\n')).toEqual([["default", "identifier", ["default"]]]);
});

test("a function or class held by a namespace value reads as its own signature", () => {
  expect(constants("export namespace N { export const f = (x: number): string => ''; export const g = function (y) {}; export const h = 1; }\n")).toEqual([
    ["N", "namespace { const f = (x: number): string; const g = (y); const h = 1 }", ["N"]],
  ]);
});

test("a function or class merged with a namespace exports the namespace's values under the same names", () => {
  expect(constants("function N() {}\nnamespace N { export const x = 1; }\nexport { N };\n")).toEqual([["N", "namespace { const x = 1 }", ["N"]]]);
  expect(constants("class N {}\nnamespace N { export const x = 1; }\nexport default N;\n")).toEqual([["N", "namespace { const x = 1 }", ["default"]]]);
  expect(nodes("function N() {}\nnamespace N { export const x = 1; }\nexport { N };\n", "src/c.ts", "function").map((node) => [node.name, node.exportedAs])).toEqual([["N", ["N"]]]);
});

test("a shorthand property with no local is a constant of kind identifier", () => {
  expect(constants("module.exports = { Buffer, A: 1 };\n", "src/c.js")).toEqual([
    ["module.exports{A}", "1", ["A", "default"]],
    ["module.exports{Buffer}", "identifier", ["Buffer", "default"]],
  ]);
  expect(constants("const k = 2;\nmodule.exports = { k };\n", "src/c.js")).toEqual([["k", "2", ["*"]]]);
});

test("blocks of one enum merge in source order, exported by name or by alias", () => {
  expect(constants("enum E { A = 1 }\nenum E { B = 2 }\nexport { E };\n")).toEqual([["E", "enum { A = 1, B = 2 }", ["E"]]]);
  expect(constants("export enum E { A = 1 }\nexport enum E { B = 2 }\n")).toEqual([["E", "enum { A = 1, B = 2 }", ["E"]]]);
  expect(moves("enum E { A = 1 }\nenum E { B = 2 }\nexport { E };\n", "enum E { A = 1 }\nenum E { B = 3 }\nexport { E };\n", "src/c.ts")).toMatchObject([{ kind: "changed", id: "constant:src/c.ts#E" }]);
});
