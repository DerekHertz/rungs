import { expect, test } from "vitest";
import { compare, contractsMoved } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { contractsReport, signatureDiff, unmentionedIds, unmentioned } from "../src/review.ts";
import { pictureOf } from "../src/compare.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));

function report(base: Record<string, string>, head: Record<string, string>, description = "") {
  const headGraph = extract(tree(head));
  const comparison = compare(extract(tree(base)), headGraph);
  const claims = unmentioned(comparison, pictureOf(headGraph, comparison).graph, description);
  return contractsReport(comparison, contractsMoved(comparison), unmentionedIds(claims));
}

const exp = (name: string, params = "", body = 1): string => `export function ${name}(${params}) {\n  return ${body};\n}\n`;

test("changed signatures come first, then removed and unexported, then exposed and moved, then added", () => {
  const base = {
    "package.json": "{}\n",
    "src/a.ts": exp("keep", "x") + exp("drop") + exp("hide") + "function show() {\n  return 1;\n}\n",
    "src/old.ts": exp("mover"),
  };
  const head = {
    "package.json": "{}\n",
    "src/a.ts": exp("keep", "x, y") + "function hide() {\n  return 1;\n}\n" + exp("show") + exp("fresh"),
    "src/new.ts": exp("mover"),
  };
  const result = report(base, head);
  expect(result.entries.map((entry) => (entry.kind === "row" ? `${entry.move.kind} ${entry.label}` : "rollup"))).toEqual([
    "changed keep",
    "removed drop",
    "unexported hide",
    "exposed show",
    "moved mover",
    "added fresh",
  ]);
  expect(result.counts).toEqual({ changed: 1, removed: 1, unexported: 1, exposed: 1, moved: 1, added: 1 });
});

test("a row names its file, its kind and both signatures", () => {
  const result = report(
    { "package.json": "{}\n", "src/a.ts": exp("keep", "x") },
    { "package.json": "{}\n", "src/a.ts": exp("keep", "x, y") },
  );
  const [row] = result.entries;
  expect(row).toMatchObject({
    kind: "row",
    label: "keep",
    path: "src/a.ts",
    level: "function",
    unmentioned: true,
    move: { kind: "changed", before: "(x)", after: "(x, y)" },
  });
});

test("a row is unmentioned unless the description names its file or it", () => {
  const base = { "package.json": "{}\n", "src/a.ts": exp("one") + exp("two") };
  const head = { "package.json": "{}\n", "src/a.ts": exp("one", "x") + exp("two", "y") };
  const flags = (description: string) =>
    report(base, head, description).entries.map((entry) => (entry.kind === "row" ? entry.unmentioned : null));
  expect(flags("Tidies up.")).toEqual([true, true]);
  expect(flags("Changes `one`.")).toEqual([false, true]);
  expect(flags("Touches src/a.ts.")).toEqual([false, false]);
});

test("a file that adds more than three exports rolls up, and one that adds three does not", () => {
  const many = (count: number): string => Array.from({ length: count }, (_, i) => exp(`f${i}`)).join("");
  const base = { "package.json": "{}\n" };
  const four = report(base, { ...base, "src/big.ts": many(4), "src/small.ts": many(3) }).entries;
  expect(four.map((entry) => (entry.kind === "rollup" ? `rollup ${entry.path} ${entry.rows.length}` : entry.path))).toEqual([
    "src/small.ts",
    "src/small.ts",
    "src/small.ts",
    "rollup src/big.ts 4",
  ]);
  const rollup = four[3]!;
  expect(rollup).toMatchObject({ kind: "rollup", moveKind: "added", fileId: "file:src/big.ts" as NodeId });
});

test("a rollup never swallows a changed row of the same file", () => {
  const many = Array.from({ length: 5 }, (_, i) => exp(`f${i}`)).join("");
  const result = report(
    { "package.json": "{}\n", "src/a.ts": exp("keep", "x") },
    { "package.json": "{}\n", "src/a.ts": exp("keep", "x, y") + many },
  );
  expect(result.entries.map((entry) => (entry.kind === "row" ? `${entry.move.kind} ${entry.label}` : `rollup ${entry.rows.length}`))).toEqual([
    "changed keep",
    "rollup 5",
  ]);
});

test("signatureDiff keeps what both sides share and marks the middle that differs", () => {
  expect(signatureDiff("function f(a)", "function f(a, b)")).toEqual({
    prefix: "function f(a",
    removed: "",
    added: ", b",
    suffix: ")",
  });
  expect(signatureDiff("function f(a: string)", "function f(a: number)")).toEqual({
    prefix: "function f(a: ",
    removed: "string",
    added: "number",
    suffix: ")",
  });
  expect(signatureDiff("same", "same")).toEqual({ prefix: "same", removed: "", added: "", suffix: "" });
});
