import { expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { observedDocument } from "../src/observed.ts";
import type { TestReport } from "../src/observed.ts";
import type { ObservedDocument } from "../src/observed-types.ts";
import { observedReport, unreliableText } from "../src/observed-report.ts";

const base: FileTree = new Map([
  ["src/sum.js", "export const sum = (a, b) => a + b;\n"],
  ["test/old.test.mjs", 'import { test } from "node:test";\ntest("old", () => {});\n'],
  ["test/kept.test.mjs", 'import { test } from "node:test";\ntest("kept", () => {});\n'],
]);
const head: FileTree = new Map([
  ["src/sum.js", "export const sum = (a, b) => a + b + 0;\n"],
  ["test/old.test.mjs", 'import { test } from "node:test";\ntest("old", () => {});\ntest("older", () => {});\n'],
  ["test/kept.test.mjs", 'import { test } from "node:test";\ntest("kept", () => {});\n'],
  ["test/sum.test.mjs", 'import { describe, it } from "node:test";\ndescribe("sum", () => {\n  it("adds", () => {});\n  it("carries", () => {});\n});\n'],
  ["test/silent.test.mjs", 'import { test } from "node:test";\ntest("never ran", () => {});\n'],
]);
const graph = extract(head);
const comparison = compare(extract(base), graph);
const reports: TestReport[] = [
  { file: "test/sum.test.mjs", path: ["sum", "adds"], outcome: "pass", ms: 1 },
  { file: "test/sum.test.mjs", path: ["sum", "carries"], outcome: "fail", ms: 2, message: "10 !== 11" },
  { file: "test/old.test.mjs", path: ["old"], outcome: "pass", ms: 1 },
  { file: "test/old.test.mjs", path: ["older"], outcome: "skip", ms: 0 },
  { file: "test/old.test.mjs", path: ["made at run time"], outcome: "fail", ms: 3 },
  { file: "test/kept.test.mjs", path: ["kept"], outcome: "fail", ms: 1 },
];
const document = observedDocument({ status: "ran", runner: "node", isolation: "bwrap", seconds: 1, exitCode: 1, reports }, graph, "t") as Extract<
  ObservedDocument,
  { status: "ran" }
>;

test("each changed test file gets its counts, failing files first, files with no result next", () => {
  expect(observedReport(document, graph, comparison).files).toEqual([
    { id: "file:test/old.test.mjs", path: "test/old.test.mjs", change: "altered", counts: { pass: 1, fail: 1, skip: 1 } },
    { id: "file:test/sum.test.mjs", path: "test/sum.test.mjs", change: "added", counts: { pass: 1, fail: 1, skip: 0 } },
    { id: "file:test/silent.test.mjs", path: "test/silent.test.mjs", change: "added", counts: { pass: 0, fail: 0, skip: 0 } },
  ]);
});

test("every failing test is listed, attached or not, and its file is marked on the picture", () => {
  const report = observedReport(document, graph, comparison);
  expect(report.failing).toEqual([
    { id: 'function:test/sum.test.mjs#"describe(\\"sum\\") callback"."it(\\"carries\\") callback"', file: "test/sum.test.mjs", name: "sum > carries", message: "10 !== 11" },
    { id: 'function:test/kept.test.mjs#"test(\\"kept\\") callback"', file: "test/kept.test.mjs", name: "kept" },
    { id: "file:test/old.test.mjs", file: "test/old.test.mjs", name: "made at run time", why: "no test function in the file has this name" },
  ]);
  expect(report.failingFiles).toEqual(new Set(["file:test/sum.test.mjs", "file:test/kept.test.mjs", "file:test/old.test.mjs"]));
});

test("an unreliable run is said plainly: why, that no result is shown, and never a count of passes", () => {
  const document: ObservedDocument = {
    tier: "observed",
    tree: "t",
    status: "unreliable",
    why: "the runner exited 1 but no failure was recorded",
    runner: "node",
    sandbox: "bwrap",
    seconds: 1.5,
    exitCode: 1,
  };
  expect(unreliableText(document)).toBe(
    "Results unreliable: the runner exited 1 but no failure was recorded. The node --test run (exit 1, 1.5s) is not shown, because its results cannot be told from ones the tests wrote themselves.",
  );
  expect(unreliableText(document)).not.toMatch(/pass/);
});
