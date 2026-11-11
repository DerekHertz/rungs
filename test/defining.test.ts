import { expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { CallResolver } from "../src/calls.ts";
import { effectStepsOf, fileWhy } from "../src/defining.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { isTestFile } from "../src/test-files.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));

function why(base: Record<string, string>, head: Record<string, string>, path: string) {
  const baseTree = tree(base);
  const headTree = tree(head);
  const baseGraph = extract(baseTree);
  const headGraph = extract(headTree);
  const comparison = compare(baseGraph, headGraph, { base: baseTree, head: headTree });
  return fileWhy(`file:${path}` as NodeId, comparison, baseGraph, headGraph, isTestFile);
}

const base = {
  "package.json": "{}\n",
  "src/core.ts":
    'import { readFileSync } from "node:fs";\nexport function api(a) {\n  return a;\n}\nfunction helper() {\n  return 1;\n}\nfunction plain() {\n  return [1].map((x) => x);\n}\nexport function same() {\n  return 0;\n}\n',
  "src/user.ts": 'import { api } from "./core.ts";\nexport const u = api;\n',
  "src/top.ts": 'import { u } from "./user.ts";\nexport const t = u;\n',
  "test/core.test.ts": 'import { u } from "../src/user.ts";\nimport { test } from "node:test";\ntest("x", () => { u; });\n',
};
const head = {
  ...base,
  "src/core.ts":
    'import { readFileSync } from "node:fs";\nimport { execFileSync } from "node:child_process";\nexport function api(a, b) {\n  return a;\n}\nfunction helper() {\n  return 2;\n}\nfunction plain() {\n  return [1].map((x) => x + 1);\n}\nexport function same() {\n  return 0;\n}\nexport function run() {\n  execFileSync("git", ["status"]);\n}\n',
};

test("the why-line carries moved contracts, dependents, new effects and the tests that reach the file", () => {
  const found = why(base, head, "src/core.ts")!;
  expect(found.why.contracts).toEqual(["api signature changed"]);
  expect(found.why.dependents).toEqual(["src/top.ts", "src/user.ts", "test/core.test.ts"]);
  expect(found.why.effects).toEqual(['new process child_process execFileSync "git"']);
  expect(found.why.testReaches).toEqual(["test/core.test.ts"]);
  expect(found.why.isTest).toBe(false);
});

test("a file no test reaches says so, and a test file is its own case", () => {
  const noTest = { ...head, "test/core.test.ts": "" };
  expect(why({ ...base, "test/core.test.ts": "" }, noTest, "src/core.ts")!.why.testReaches).toEqual([]);
  const own = 'import { test } from "node:test";\ntest("y", () => {});\n';
  expect(why(base, { ...head, "test/core.test.ts": own }, "test/core.test.ts")!.why.isTest).toBe(true);
});

test("defining blocks list contract moves, then effects, then exports, then the rest; an unchanged block is absent", () => {
  const found = why(base, head, "src/core.ts")!;
  expect(found.defining.map((block) => [block.label, block.reasons])).toEqual([
    ["api", ["contract signature changed", "exported"]],
    ["run", ['new process child_process execFileSync "git"', "exported"]],
  ]);
  expect(found.other.map((block) => block.label)).toEqual(["helper", "plain"]);
});

test("a changed callback folds under its holder and imports fold under the file", () => {
  const found = why(base, head, "src/core.ts")!;
  const plain = found.other.find((block) => block.label === "plain")!;
  expect(plain.folded).toHaveLength(1);
  expect(found.foldedLoose.imports).toBe(1);
  expect(found.foldedLoose.callbacks).toBe(0);
});

test("a file the head does not have has no why", () => {
  expect(why(base, head, "src/missing.ts")).toBeUndefined();
});

test("effect steps are the block's outside calls; calls to other blocks are call edges, not here", () => {
  const graph = extract(tree(head));
  expect(effectStepsOf(graph, "function:src/core.ts#run" as NodeId)).toEqual([{ label: 'process child_process execFileSync "git"' }]);
});

test("the changed blocks with the most callers are defining, ranked after exported ones", () => {
  const files = {
    "package.json": "{}\n",
    "src/a.ts": "function busy() {\n  return 1;\n}\nfunction quiet() {\n  return 1;\n}\nexport function f() {\n  busy();\n  busy();\n  quiet();\n}\nexport function h() {\n  busy();\n}\n",
  };
  const after = { ...files, "src/a.ts": files["src/a.ts"].replaceAll("return 1", "return 2") };
  const baseTree = tree(files);
  const headTree = tree(after);
  const baseGraph = extract(baseTree);
  const headGraph = extract(headTree);
  const comparison = compare(baseGraph, headGraph, { base: baseTree, head: headTree });
  const found = fileWhy("file:src/a.ts" as NodeId, comparison, baseGraph, headGraph, isTestFile, new CallResolver(headTree, headGraph))!;
  expect(found.defining.map((block) => [block.label, block.reasons])).toEqual([["busy", ["most callers (2)"]]]);
  expect(found.other.map((block) => block.label)).toEqual(["quiet"]);
  expect(found.defining[0]!.callers!.map((ref) => ref.label)).toEqual(["f", "h"]);
  expect(found.other[0]!.callers!.map((ref) => ref.label)).toEqual(["f"]);
  // Without the resolver there is no such ranking.
  expect(fileWhy("file:src/a.ts" as NodeId, comparison, baseGraph, headGraph, isTestFile)!.defining).toEqual([]);
});

test("a block whose text is unchanged but whose import now reaches an effect is defining", () => {
  const before = { "package.json": "{}\n", "src/f.ts": 'import { run } from "./r.ts";\nexport function f() {\n  run("x");\n}\nexport function g() {\n  return 1;\n}\n', "src/r.ts": "export function run(a) {\n  return a;\n}\n" };
  const after = { ...before, "src/f.ts": before["src/f.ts"].replace('import { run } from "./r.ts"', 'import { unlinkSync as run } from "node:fs"') };
  const found = why(before, after, "src/f.ts")!;
  expect(found.defining.map((block) => block.label)).toEqual(["f"]);
  expect(found.defining[0]!.reasons).toEqual(["contract effects changed", "new file system fs unlinkSync \"x\"", "exported"]);
  expect(found.other).toEqual([]);
});

test("a changed require.resolve is not an effect", () => {
  const before = { "package.json": "{}\n", "src/f.ts": 'export function f() {\n  return require.resolve("a");\n}\n' };
  const found = why(before, { ...before, "src/f.ts": before["src/f.ts"].replace('"a"', '"b"') }, "src/f.ts")!;
  expect(found.why.effects).toEqual([]);
  expect(found.defining[0]!.reasons).toEqual(["exported"]);
});
