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
