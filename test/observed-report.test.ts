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
  ["test/gone.test.mjs", 'import { test } from "node:test";\ntest("deleted one", () => {});\n'],
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
// Main's tests ran against the head: the base's files, so nothing of the PR's new sum.test.mjs is in them.
const reports: TestReport[] = [
  { file: "test/old.test.mjs", path: ["old"], outcome: "pass", ms: 1 },
  { file: "test/old.test.mjs", path: ["made at run time"], outcome: "fail", ms: 3 },
  { file: "test/kept.test.mjs", path: ["kept"], outcome: "fail", ms: 1 },
  { file: "test/gone.test.mjs", path: ["deleted one"], outcome: "fail", ms: 1 },
];
const written = { files: ["test/sum.test.mjs", "test/silent.test.mjs"], seconds: 1, outcome: { status: "ran", exitCode: 1, reports: [
  { file: "test/sum.test.mjs", path: ["sum", "adds"], outcome: "pass", ms: 1 },
  { file: "test/sum.test.mjs", path: ["sum", "carries"], outcome: "fail", ms: 2, message: "10 !== 11" },
] } } as const;
const document = observedDocument({ status: "ran", runner: "node", isolation: "bwrap", seconds: 1, exitCode: 1, reports, deleted: ["test/gone.test.mjs"], edited: ["test/old.test.mjs"], written }, graph, "t") as Extract<
  ObservedDocument,
  { status: "ran" }
>;

test("each changed test file gets the counts of main's tests in it, failing first, the deleted ones too, then files with no result", () => {
  expect(observedReport(document, graph, comparison).files).toEqual([
    { id: "file:test/gone.test.mjs", path: "test/gone.test.mjs", change: "removed", counts: { pass: 0, fail: 1, skip: 0 } },
    { id: "file:test/old.test.mjs", path: "test/old.test.mjs", change: "altered", counts: { pass: 1, fail: 1, skip: 0 } },
    { id: "file:test/silent.test.mjs", path: "test/silent.test.mjs", change: "added", counts: { pass: 0, fail: 0, skip: 0 } },
    { id: "file:test/sum.test.mjs", path: "test/sum.test.mjs", change: "added", counts: { pass: 0, fail: 0, skip: 0 } },
  ]);
});

test("every failing test is listed, attached or not, and its file is marked on the picture", () => {
  const report = observedReport(document, graph, comparison);
  expect(report.failing).toEqual([
    { id: 'function:test/kept.test.mjs#"test(\\"kept\\") callback"', file: "test/kept.test.mjs", name: "kept" },
    { id: "file:test/old.test.mjs", file: "test/old.test.mjs", name: "made at run time", why: "main's version of this file ran; this PR edited it" },
    { id: "file:test/gone.test.mjs", file: "test/gone.test.mjs", name: "deleted one", why: "main's test, run against this PR's code; this PR deleted the file" },
  ]);
  // The graph given is the head's, which has no deleted file; the page gives the picture's graph, which has its ghost.
  expect(report.failingFiles).toEqual(new Set(["file:test/old.test.mjs", "file:test/kept.test.mjs"]));
});

test("the tests the PR wrote are reported apart from the evidence, and name which base files were deleted or edited", () => {
  const report = observedReport(document, graph, comparison);
  expect(report.deleted).toEqual(["test/gone.test.mjs"]);
  expect(report.edited).toEqual(["test/old.test.mjs"]);
  expect(report.written).toEqual({
    status: "ran",
    files: [
      { path: "test/sum.test.mjs", counts: { pass: 1, fail: 1, skip: 0 } },
      { path: "test/silent.test.mjs", counts: { pass: 0, fail: 0, skip: 0 } },
    ],
    counts: { pass: 1, fail: 1, skip: 0 },
    failing: [{ file: "test/sum.test.mjs", name: "sum > carries", message: "10 !== 11" }],
  });
  expect(report.failing.every((test) => !test.file.endsWith("sum.test.mjs"))).toBe(true);
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

test("a test file moved away with a failing base test keeps its flag: the old path counts as a place of the picture", () => {
  const text = 'import { test } from "node:test";\ntest("old", () => {});\n';
  const moveBase: FileTree = new Map([["test/old.test.mjs", text]]);
  const moveGraph = extract(new Map([["test/new.test.mjs", text]]));
  const moveComparison = compare(extract(moveBase), moveGraph);
  const moveDocument = observedDocument(
    { status: "ran", runner: "node", isolation: "bwrap", seconds: 1, exitCode: 1, reports: [{ file: "test/old.test.mjs", path: ["old"], outcome: "fail", ms: 1 }], deleted: [], edited: [] },
    extract(moveBase),
    "t",
  ) as Extract<ObservedDocument, { status: "ran" }>;
  const report = observedReport(moveDocument, moveGraph, moveComparison);
  expect(report.failing.map((test) => test.file)).toEqual(["test/old.test.mjs"]);
  expect(report.failingFiles).toEqual(new Set(["file:test/old.test.mjs"]));
});
