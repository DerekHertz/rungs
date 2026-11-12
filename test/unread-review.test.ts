import { describe, expect, test } from "vitest";
import { fileWhy, whyLine } from "../src/defining.ts";
import { extract } from "../src/extract/extract.ts";
import { headline } from "../src/headline.ts";
import { isCodeNode } from "../src/graph.ts";
import type { FileNode, FileTree, NodeId } from "../src/graph.ts";
import { possiblyReachedFrom, reachedFrom } from "../src/importance.ts";
import { readableComparison } from "../src/readable.ts";
import { qualifyUnread } from "../src/review-summary.ts";
import { risksOf } from "../src/risks.ts";
import { testChanges } from "../src/test-changes.ts";

const fileOf = (files: FileTree, path: string): FileNode => extract(files).nodes.find((node): node is FileNode => node.level === "file" && node.path === path)!;
const GOOD = 'import fs from "node:fs";\nexport function load(path) {\n  return fs.readFileSync(path);\n}\n';
const BROKEN = 'import fs from "node:fs";\nexport function load(path) {\n  return fs.readFileSync(path;\n}\n';
const tree = (text: string): FileTree => new Map([["package.json", "{}\n"], ["a.ts", text]]);

describe("what a parse failure must not let a review say", () => {
  const TYPED_JS = new Map([["a.js", "export function f(x: number) {}\n"]]);

  test("TypeScript-only syntax in a .js file is not read: its contract would be a guess", () => {
    expect(fileOf(TYPED_JS, "a.js").analysis).toBe("not fully read");
    expect(extract(TYPED_JS).nodes.some((node) => isCodeNode(node))).toBe(false);
  });

  const lib = (signature: string): string => `export function f(${signature}) {\n  return 1;\n}\n`;
  const entryTree = (entry: string, signature: string): FileTree => new Map([["package.json", '{"main":"entry.ts"}\n'], ["entry.ts", entry], ["lib.ts", lib(signature)]]);
  const GOOD_ENTRY = 'import { f } from "./lib.ts";\nf(1);\n';
  const BROKEN_ENTRY = 'import { f } from "./lib.ts";\nf(;\n';

  test("what an unread file imports is unknown: a risk's blast says so instead of 0", () => {
    const { baseGraph, graph, comparison } = readableComparison(entryTree(GOOD_ENTRY, "a: number"), entryTree(BROKEN_ENTRY, "a: number, b: number"));
    const risk = risksOf(comparison, baseGraph, graph, testChanges(new Map(), new Map()), () => false).find((item) => item.kind === "contract");
    expect(risk?.blast).toMatchObject({ count: 0, unknown: 1 });
  });

  test("a file an unread way in might import is never 'nothing reaches it'", () => {
    const { graph } = readableComparison(entryTree(GOOD_ENTRY, "a: number"), entryTree(BROKEN_ENTRY, "a: number"));
    const libId = graph.nodes.find((node) => node.level === "file" && node.path === "lib.ts")!.id;
    const entryId = graph.nodes.find((node) => node.level === "file" && node.path === "entry.ts")!.id;
    expect(reachedFrom(graph, [entryId]).has(libId)).toBe(false);
    expect(possiblyReachedFrom(graph, [entryId]).has(libId)).toBe(true);
  });

  test("the file panel's line says unknown dependents for lib.ts, and could not read for the unread file", () => {
    const { baseGraph, graph, comparison } = readableComparison(entryTree(GOOD_ENTRY, "a: number"), entryTree(BROKEN_ENTRY, "a: number, b: number"));
    const why = (path: string): string => whyLine(fileWhy(`file:${path}` as NodeId, comparison, baseGraph, graph, () => false)!);
    expect(why("lib.ts")).toContain("unknown via 1 unread file");
    expect(why("lib.ts")).not.toContain("no file rests on it");
    expect(why("entry.ts")).toContain("could not read");
    expect(why("entry.ts")).not.toContain("no contract moved");
  });

  test("a summary that says none says it of the readable files only", () => {
    expect(qualifyUnread("none found", 0)).toBe("none found");
    expect(qualifyUnread("none found", 1)).toBe("none found in readable files · 1 file could not be read");
    expect(qualifyUnread("2 risks", 2)).toBe("2 risks · 2 files could not be read");
  });

  test("the headline says how many files could not be read and counts none of their code", () => {
    const { comparison } = readableComparison(tree(GOOD), tree(BROKEN));
    const line = headline(comparison, testChanges(new Map(), new Map()), null);
    expect(line).toContain("1 file could not be read");
    expect(line).not.toContain("code");
  });

  test("the unread count and a test run still under way are both in the headline", () => {
    const { comparison } = readableComparison(tree(GOOD), tree(BROKEN));
    const line = headline(comparison, testChanges(new Map(), new Map()), { tier: "observed", tree: "t", status: "running", stage: "tests" });
    expect(line).toContain("1 file could not be read");
    expect(line).toContain("tests running…");
  });

  const TEST_GOOD ='import { test, expect } from "vitest";\ntest("works", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n';
  const TEST_BROKEN = 'import { test, expect } from "vitest";\ntest("works", () => {\n  expect(1).toBe(1;\n});\n';

  test("a test file that fails to parse gives no weakened or removed tests", () => {
    const made = readableComparison(new Map([["package.json", "{}\n"], ["a.test.ts", TEST_GOOD]]), new Map([["package.json", "{}\n"], ["a.test.ts", TEST_BROKEN]]));
    const changes = testChanges(made.baseTree, made.headTree);
    expect([changes.weakened, changes.removedTests, changes.deletedFiles, changes.markers]).toEqual([[], [], [], []]);
    expect(made.comparison.unread).toEqual([{ path: "a.test.ts", side: "head" }]);
  });

  test("a rename where only one side parses withholds both paths: no phantom added function", () => {
    const view = "export function View() {\n  return <div />;\n}\n";
    const made = readableComparison(new Map([["package.json", "{}\n"], ["view.ts", view]]), new Map([["package.json", "{}\n"], ["view.tsx", view]]));
    expect(made.comparison.changes.some((change) => isCodeNode(change.node))).toBe(false);
    expect(made.comparison.unread.map((file) => file.path)).toEqual(["view.ts", "view.tsx"]);
  });
});
