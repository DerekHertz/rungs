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
const lines = (result: ReturnType<typeof report>): string[] => result.entries.map((entry) => (entry.kind === "row" ? `${entry.move.kind} ${entry.label}` : "rollup"));
const fn = (name: string): string => `export function ${name}() {\n  return 1;\n}\n`;

test("an exported interface that gains a member is a changed contract, named by the interface", () => {
  const result = report(
    { ...pkg, "src/t.ts": "export interface Lot {\n  readonly id: string;\n}\n" },
    { ...pkg, "src/t.ts": "export interface Lot {\n  readonly id: string;\n  readonly folder: NodeId;\n}\n" },
  );
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({
    kind: "row",
    label: "Lot",
    path: "src/t.ts",
    level: "interface",
    move: { kind: "changed", before: "{ readonly id: string }", after: "{ readonly id: string; readonly folder: NodeId }" },
  });
});

test("an exported type alias that gains a union member is changed", () => {
  const result = report(
    { ...pkg, "src/t.ts": 'export type Kind = "a" | "b";\n' },
    { ...pkg, "src/t.ts": 'export type Kind = "a" | "b" | "c";\n' },
  );
  expect(result.entries).toMatchObject([{ label: "Kind", level: "type", move: { kind: "changed" } }]);
});

test("removed and added interfaces and aliases are listed; unexported ones, reformatting and comments are not", () => {
  const result = report(
    { ...pkg, "src/t.ts": "export interface Gone { a: 1 }\nexport type Same = { a: number };\ninterface Hidden { a: 1 }\n" },
    { ...pkg, "src/t.ts": "export type Same = {\n  // note\n  a: number;\n};\ninterface Hidden { a: 2 }\nexport type Fresh = string;\n" },
  );
  expect(lines(result)).toEqual(["removed Gone", "added Fresh"]);
});

test("an interface in a file that only moved is no contract move", () => {
  const body = "export interface A {\n  x: number;\n}\n" + fn("f");
  expect(lines(report({ ...pkg, "src/a.ts": body }, { ...pkg, "src/b.ts": body }))).toEqual(["moved f"]);
});

test("an interface listed in an export clause counts as exported", () => {
  const result = report(
    { ...pkg, "src/t.ts": "interface A { x: 1 }\nexport type { A };\n" },
    { ...pkg, "src/t.ts": "interface A { x: 1; y: 2 }\nexport type { A };\n" },
  );
  expect(result.entries).toMatchObject([{ label: "A", move: { kind: "changed" } }]);
});

const one = (base: string, head: string, file = "src/t.ts"): string[] => lines(report({ ...pkg, [file]: base }, { ...pkg, [file]: head }));

test("a declaration file's interface is a contract", () => {
  expect(one("export interface A { x: string }\n", "export interface A { x: number }\n", "src/api.d.ts")).toEqual(["changed A"]);
});

test("a re-export is a contract by its exported name, and not resolved here", () => {
  expect(one('export type { A } from "./types";\n', "export {};\n")).toEqual(["removed A"]);
  expect(one("export {};\n", 'export type { A as B } from "./types";\n')).toEqual(["added B"]);
  expect(one('export type { A } from "./types";\n', 'export type { A } from "./types";\n')).toEqual([]);
  expect(one('export type { A } from "./types";\n', 'export type { A } from "./other";\n')).toEqual(["changed A"]);
  expect(one("export {};\n", 'export * from "./types";\n')).toEqual(['added * from "./types"']);
});

test("members of exported and ambient namespaces are contracts, qualified by the namespace", () => {
  expect(one("export namespace API { export interface A { x: 1 } }\n", "export namespace API { export interface A { x: 1; y: 2 } }\n")).toEqual(["changed API.A"]);
  expect(one("export declare namespace API { interface A { x: 1 } }\n", "export declare namespace API { interface A { x: 2 } }\n")).toEqual(["changed API.A"]);
  expect(one("namespace API { export interface A { x: 1 } }\n", "namespace API { export interface A { x: 2 } }\n")).toEqual([]);
});

test("a default export of an interface is a contract named default", () => {
  expect(one("interface A { x: 1 }\nexport default A;\n", "interface A { x: 2 }\nexport default A;\n")).toEqual(["changed default"]);
  expect(one("export default interface A { x: 1 }\n", "export default interface A { x: 2 }\n")).toEqual(["changed default"]);
});

test("a type is identified by its exported name, not its local one", () => {
  expect(one("interface A { x: 1 }\nexport type { A as Public };\n", "interface A { x: 1 }\nexport type { A as Renamed };\n")).toEqual(["removed Public", "added Renamed"]);
  expect(one("export default interface A {}\n", "export interface A {}\n")).toEqual(["removed default", "added A"]);
  expect(one("interface A { x: 1 }\nexport type { A as P };\n", "interface A { x: 2 }\nexport type { A as P };\n")).toEqual(["changed P"]);
});

test("formatting alone is no change, however members are separated or nested", () => {
  expect(one("export type A = { x: string; y: number };\n", "export type A = {\n  x: string\n  y: number\n};\n")).toEqual([]);
  expect(one("export interface A { o: { x: string, y: number } }\n", "export interface A {\n  o: {\n    x: string\n    y: number;\n  };\n}\n")).toEqual([]);
  expect(one("export interface A { x(a: 1): void, y: 2 }\n", "export interface A {\n  x(a: 1): void;\n  y: 2\n}\n")).toEqual([]);
});

test("consolidating a merged interface is no change; adding a merged member is", () => {
  expect(one("export interface A { x: string }\nexport interface A { y: number }\n", "export interface A { x: string; y: number }\n")).toEqual([]);
  expect(one("export interface A { x: string }\n", "export interface A { x: string }\nexport interface A { y: number }\n")).toEqual(["changed A"]);
});
