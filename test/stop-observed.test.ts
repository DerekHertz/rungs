import { expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import type { ObservedDocument } from "../src/observed-types.ts";
import { observedAt } from "../src/stops.ts";
import type { TestChanges } from "../src/test-changes-types.ts";
import type { Stop } from "../src/tour.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const unit = 'import test from "node:test";\ntest("loads", () => {});\ntest("fails", () => {});\n';
const base = extract(tree({ "package.json": "{}\n", "src/api.ts": "export function load() {\n  return 1;\n}\n", "test/api.test.ts": unit }));
const head = extract(tree({ "package.json": "{}\n", "src/api.ts": "export function load() {\n  return 2;\n}\n", "test/api.test.ts": unit + 'test("new", () => {});\n' }));
const comparison = compare(base, head);
const graph = pictureOf(head, comparison).graph;
const loads = 'function:test/api.test.ts#"test(\\"loads\\") callback"' as NodeId;
const fails = 'function:test/api.test.ts#"test(\\"fails\\") callback"' as NodeId;

const stop = (...ids: string[]): Stop => ({ title: "t", ids: ids as NodeId[], claims: [], sentences: [] });
const none: TestChanges = { deletedFiles: [], removedTests: [], markers: [], weakened: [] };
const ran = (over: Partial<Extract<ObservedDocument, { status: "ran" }>> = {}): ObservedDocument => ({
  tier: "observed",
  tree: "t",
  status: "ran",
  runner: "node",
  sandbox: "bwrap",
  seconds: 1,
  exitCode: 1,
  counts: { pass: 1, fail: 1, skip: 0 },
  tests: { [loads]: [{ name: "loads", outcome: "pass", ms: 1 }], [fails]: [{ name: "fails", outcome: "fail", ms: 1, message: "boom" }] },
  unmatched: [],
  deleted: [],
  edited: [],
  written: null,
  ...over,
});
const at = (ids: string[], document: ObservedDocument | null, changes = none) => observedAt(stop(...ids), graph, comparison, document, changes);

test("with no run recorded a stop is not run", () => {
  expect(at(["file:src/api.ts"], null)).toEqual({ status: "not run" });
});

test("a refused, unsupported, failed or unreliable run shows its state and reason at every stop", () => {
  const refused: ObservedDocument = { tier: "observed", tree: "t", status: "refused", why: "no sandbox" };
  expect(at(["file:src/api.ts"], refused)).toEqual({ status: "refused", why: "no sandbox", unsandboxed: false });
  const unreliable: ObservedDocument = { tier: "observed", tree: "t", status: "unreliable", why: "exit 0 with failures", runner: "node", sandbox: "unsandboxed", seconds: 2, exitCode: 0 };
  expect(at(["file:test/api.test.ts"], unreliable)).toEqual({ status: "unreliable", why: "exit 0 with failures", unsandboxed: true });
});

test("a stop at a test file shows main's results of the test functions in it", () => {
  const found = at(["file:test/api.test.ts"], ran());
  expect(found).toEqual({
    status: "ran",
    unsandboxed: false,
    results: [
      { file: "test/api.test.ts", name: "loads", outcome: "pass" },
      { file: "test/api.test.ts", name: "fails", outcome: "fail", message: "boom" },
    ],
    written: [],
    changes: [],
  });
});

test("a stop at one test function shows only that function's results", () => {
  const found = at([fails], ran());
  expect(found.status === "ran" && found.results.map((result) => result.name)).toEqual(["fails"]);
});

test("a stop with no test attached has no results, and results unattached to a function show for their file", () => {
  const unmatched = [{ file: "test/api.test.ts", name: "odd", outcome: "skip" as const, ms: 0, why: "no single test function has this name" }];
  expect(at(["file:src/api.ts"], ran({ unmatched }))).toMatchObject({ status: "ran", results: [], written: [], changes: [] });
  const found = at(["file:test/api.test.ts"], ran({ tests: {}, unmatched }));
  expect(found.status === "ran" && found.results).toEqual([{ file: "test/api.test.ts", name: "odd", outcome: "skip", why: "no single test function has this name" }]);
});

test("tests the PR wrote are separate from main's results", () => {
  const written = {
    tier: "claimed" as const,
    files: ["test/api.test.ts"],
    seconds: 1,
    status: "ran" as const,
    exitCode: 0,
    counts: { pass: 1, fail: 0, skip: 0 },
    tests: [{ file: "test/api.test.ts", name: "new", outcome: "pass" as const, ms: 1 }],
  };
  const found = at(["file:test/api.test.ts"], ran({ written }));
  expect(found.status === "ran" && found.written).toEqual([{ file: "test/api.test.ts", name: "new", outcome: "pass" }]);
  expect(at(["file:src/api.ts"], ran({ written }))).toMatchObject({ results: [], written: [] });
});

test("tests removed, weakened, skipped or deleted in the stop's files are listed from /test-changes.json", () => {
  const changes: TestChanges = {
    deletedFiles: [{ path: "test/gone.test.ts", tests: 2 }],
    removedTests: [{ file: "test/api.test.ts", name: "old" }],
    markers: [{ file: "test/api.test.ts", name: "fails", marker: "skip" }],
    weakened: [{ file: "test/api.test.ts", name: "loads", why: "fewer assertions" }],
  };
  const found = at(["file:test/api.test.ts"], ran(), changes);
  expect(found.status === "ran" && found.changes).toEqual(["test removed: old", "fails marked skip", "loads weakened: fewer assertions"]);
  expect(at(["file:src/api.ts"], ran(), changes)).toMatchObject({ changes: [] });
});
