import { describe, expect, test } from "vitest";
import { contractsMoved } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { isCodeNode } from "../src/graph.ts";
import type { FileNode, FileTree } from "../src/graph.ts";
import { reachedFrom } from "../src/importance.ts";
import { readableComparison } from "../src/readable.ts";
import { townOf } from "../src/town.ts";

const GOOD = 'import fs from "node:fs";\nexport function load(path) {\n  return fs.readFileSync(path);\n}\nexport class Box {\n  open() {}\n}\n';
const BROKEN = 'import fs from "node:fs";\nexport function load(path) {\n  return fs.readFileSync(path;\n}\nexport class Box {\n  open() {}\n';
const TYPE_ERRORS = 'export function load(path: string): number {\n  return "not a number" + missing;\n}\nconst x: string = 3;\n';

const fileOf = (files: FileTree, path: string): FileNode => extract(files).nodes.find((node): node is FileNode => node.level === "file" && node.path === path)!;
const tree = (text: string): FileTree => new Map([["package.json", "{}\n"], ["a.ts", text], ["b.ts", 'import { load } from "./a.ts";\nexport const b = load;\n']]);

describe("a file whose parse reports syntax errors", () => {
  test("is not analysed as code: its own state, with nothing the compiler recovered", () => {
    const graph = extract(tree(BROKEN));
    expect(fileOf(tree(BROKEN), "a.ts")).toMatchObject({ analysis: "not fully read", role: "source" });
    expect(graph.nodes.filter((node) => isCodeNode(node) && node.path === "a.ts")).toEqual([]);
    expect(graph.edges.filter((edge) => edge.kind === "effect")).toEqual([]);
    expect(graph.imports.filter((edge) => edge.from === fileOf(tree(BROKEN), "a.ts").id)).toEqual([]);
    expect(fileOf(tree(BROKEN), "a.ts").types).toBeUndefined();
  });

  test("a TS file with only type errors is still fully read", () => {
    expect(fileOf(tree(TYPE_ERRORS), "a.ts").analysis).toBe("analysed");
    expect(extract(tree(TYPE_ERRORS)).nodes.some((node) => isCodeNode(node) && node.path === "a.ts")).toBe(true);
  });

  test("a clean file stays analysed", () => {
    expect(fileOf(tree(GOOD), "a.ts").analysis).toBe("analysed");
  });

  test("is code: reached only when a way in reaches it", () => {
    const graph = extract(tree(BROKEN));
    const id = fileOf(tree(BROKEN), "a.ts").id;
    expect(reachedFrom(graph, []).has(id)).toBe(false);
    expect(reachedFrom(graph, [id]).has(id)).toBe(true);
  });

  test("its lot says so, and the picture can draw it apart", () => {
    const town = townOf(extract(tree(BROKEN)), new Set(["workshop-1", "workshop-2", "workshop-3"]));
    expect(town.lots.find((lot) => lot.path === "a.ts")?.unread).toBe(true);
    expect(town.lots.find((lot) => lot.path === "b.ts")?.unread).toBe(false);
  });
});

describe("a file broken the same way on both sides", () => {
  test("stays unread in the picture and is listed, as both, so no answer is said of it", () => {
    const { graph, comparison } = readableComparison(tree(BROKEN), tree(BROKEN));
    expect(comparison.unread).toEqual([{ path: "a.ts", side: "both" }]);
    expect(graph.nodes.find((node) => node.level === "file" && node.path === "a.ts")).toMatchObject({ analysis: "not fully read" });
  });
});

describe("a file that parses on one side and fails on the other", () => {
  test("broken on head only: no removed functions, contracts or calls, and it says could not read", () => {
    const { baseGraph, graph, comparison } = readableComparison(tree(GOOD), tree(BROKEN));
    expect(comparison.changes.map((change) => `${change.kind} ${change.node.id}`)).toEqual(["altered file:a.ts"]);
    expect(comparison.effects).toEqual([]);
    expect(comparison.imports).toEqual([]);
    expect(contractsMoved(comparison, baseGraph, graph)).toEqual([]);
    expect(comparison.unread).toEqual([{ path: "a.ts", side: "head" }]);
  });

  test("broken on base only: no added functions, contracts or calls", () => {
    const { baseGraph, graph, comparison } = readableComparison(tree(BROKEN), tree(GOOD));
    expect(comparison.changes.map((change) => `${change.kind} ${change.node.id}`)).toEqual(["altered file:a.ts"]);
    expect(comparison.effects).toEqual([]);
    expect(contractsMoved(comparison, baseGraph, graph)).toEqual([]);
    expect(comparison.unread).toEqual([{ path: "a.ts", side: "base" }]);
  });

  test("broken on both sides", () => {
    const { comparison } = readableComparison(tree(BROKEN), tree(BROKEN + "// more\n"));
    expect(comparison.unread).toEqual([{ path: "a.ts", side: "both" }]);
    expect(comparison.changes.map((change) => change.node.id)).toEqual(["file:a.ts"]);
  });

  test("the head file is marked not fully read even when only the base failed, so no zero is drawn for it", () => {
    const { graph } = readableComparison(tree(BROKEN), tree(GOOD));
    expect(graph.nodes.find((node) => node.level === "file" && node.path === "a.ts")).toMatchObject({ analysis: "not fully read" });
  });

  test("a broken file added by the change is added, unread, with no code under it", () => {
    const { comparison, graph } = readableComparison(new Map([["package.json", "{}\n"]]), tree(BROKEN));
    expect(comparison.unread).toEqual([{ path: "a.ts", side: "head" }]);
    expect(graph.nodes.some((node) => isCodeNode(node) && node.path === "a.ts")).toBe(false);
  });

  test("files that read on both sides compare as before", () => {
    const { comparison } = readableComparison(tree(GOOD), tree(GOOD.replace("open() {}", "open() {}\n  close() {}")));
    expect(comparison.unread).toEqual([]);
    expect(comparison.changes.some((change) => change.node.level === "function" || change.node.level === "class")).toBe(true);
  });
});
