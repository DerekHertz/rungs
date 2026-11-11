import { expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { fileWhy, whyLine } from "../src/defining.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { isTestFile } from "../src/test-files.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const found = (base: Record<string, string>, head: Record<string, string>, path: string) => {
  const [b, h] = [tree(base), tree(head)];
  const [bg, hg] = [extract(b), extract(h)];
  return fileWhy(`file:${path}` as NodeId, compare(bg, hg, { base: b, head: h }), bg, hg, isTestFile)!;
};

test("new and changed effects are counted and labelled apart", () => {
  const before = { "package.json": "{}\n", "src/f.ts": 'export function f() {\n  fetch("u", { method: "GET" });\n}\n' };
  const changed = found(before, { ...before, "src/f.ts": before["src/f.ts"].replace("GET", "POST") }, "src/f.ts");
  expect(whyLine(changed)).toContain("1 changed effect");
  expect(whyLine(changed)).not.toContain("new effect");
  const both = { ...changed, why: { ...changed.why, effects: ["new process a", "new process b", "changed network fetch"] } };
  expect(whyLine(both)).toContain("2 new effects · 1 changed effect");
});

test("a pure move lists no unchanged block", () => {
  const text = "export function pub() {\n  return 1;\n}\nfunction helper() {\n  return 2;\n}\n";
  const result = found({ "package.json": "{}\n", "src/old.ts": text }, { "package.json": "{}\n", "src/new.ts": text }, "src/new.ts");
  expect(result.other).toEqual([]);
});
