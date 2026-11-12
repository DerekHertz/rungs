import { expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { classify } from "../src/control.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { observedDocument } from "../src/observed.ts";
import type { TestReport } from "../src/observed.ts";
import type { Outcome, RanObserved } from "../src/observed-types.ts";
import { fileMark, observedReport, rowOutcome } from "../src/observed-report.ts";

const at = (path: string[], outcome: Outcome, message?: string): TestReport => ({ file: "test/a.test.mjs", path, outcome, ms: 1, ...(message ? { message } : {}) });

test("classification table: each pair of outcomes on main and on the PR is one verdict, and a missing or skipped side is never a pass or a regression", () => {
  const head = [at(["pp"], "pass"), at(["pf"], "pass"), at(["fp"], "fail"), at(["ff"], "fail"), at(["fs"], "fail"), at(["sp"], "skip"), at(["pm"], "pass"), at(["fm"], "fail"), at(["ps"], "pass")];
  const base = [at(["pp"], "pass"), at(["pf"], "fail"), at(["fp"], "pass"), at(["ff"], "fail"), at(["fs"], "skip"), at(["sp"], "pass"), at(["ps"], "skip"), at(["gone"], "fail")];
  const { verdicts, baseOnly, counts } = classify(head, base);
  expect(verdicts).toEqual(["passes", "fixed", "regression", "environment", "skipped", "skipped", "head only", "head only", "skipped"]);
  expect(baseOnly.map((report) => report.path)).toEqual([["gone"]]);
  expect(counts).toEqual({ regression: 1, environment: 1, fixed: 1, passes: 1, skipped: 3, "head only": 2, "base only": 1, unclear: 0 });
});

test("a name that appears twice on either side is unclear, never a regression", () => {
  const { verdicts, counts } = classify([at(["same"], "fail"), at(["same"], "pass")], [at(["same"], "pass")]);
  expect(verdicts).toEqual(["unclear", "unclear"]);
  expect(counts.regression).toBe(0);
});

test("a file that fails outside any test only on the PR is a regression; failing there on main too is environment", () => {
  const file = (outcome: Outcome): TestReport => ({ file: "test/b.test.mjs", path: [], outcome, ms: 1, suite: true });
  const other = (): TestReport => ({ file: "test/b.test.mjs", path: ["x"], outcome: "pass", ms: 1 });
  expect(classify([file("fail")], [other()]).verdicts).toEqual(["regression"]);
  expect(classify([file("fail")], [file("fail")]).verdicts).toEqual(["environment"]);
  expect(classify([file("fail")], []).verdicts).toEqual(["head only"]);
});

test("a crash of a whole file on the PR, reported as a test named after the file, is a regression when main's tests in that file passed", () => {
  const crash = (): TestReport => ({ file: "test/b.test.mjs", path: ["test/b.test.mjs"], outcome: "fail", ms: 1, message: "Cannot find module" });
  const passing = [{ file: "test/b.test.mjs", path: ["x"], outcome: "pass", ms: 1 }, { file: "test/b.test.mjs", path: ["y"], outcome: "pass", ms: 1 }] as const;
  expect(classify([crash()], passing).verdicts).toEqual(["regression"]);
  // Main's file had a failure of its own: the crash cannot be paired, so it is said so, never a pass or a regression.
  expect(classify([crash()], [{ ...passing[0], outcome: "fail" }]).verdicts).toEqual(["head only"]);
});

test("a head failure that cannot be paired stays in the report as failed and not compared", () => {
  const document = observedDocument({ ...ran, reports: [at(["surprise"], "fail", "boom")], control: { status: "ran", seconds: 1, reports: [at(["broke"], "fail")] } }, graph, "t") as RanObserved;
  const report = observedReport(document, graph, comparison);
  expect(report.failing).toEqual([]);
  expect(report.others.map((test) => [test.name, test.verdict, test.outcome])).toEqual([["surprise", "head only", "fail"]]);
});

test("each row of the other results is marked by what it is: fixed passes, an environment failure fails, skipped is skipped", () => {
  expect(rowOutcome({ verdict: "fixed", outcome: "pass" })).toBe("pass");
  expect(rowOutcome({ verdict: "environment", outcome: "fail" })).toBe("fail");
  expect(rowOutcome({ verdict: "skipped", outcome: "skip" })).toBe("skip");
  expect(rowOutcome({ verdict: "head only", outcome: "fail" })).toBe("fail");
  expect(rowOutcome({ verdict: "unclear", outcome: "pass" })).toBe("pass");
  expect(rowOutcome({ outcome: "fail" })).toBe("fail");
});

const base: FileTree = new Map([["test/a.test.mjs", 'import { test } from "node:test";\ntest("broke", () => {});\ntest("env", () => {});\ntest("good", () => {});\n']]);
const graph = extract(base);
const comparison = compare(graph, graph);
const headReports = [at(["broke"], "fail", "10 !== 11"), at(["env"], "fail", "no browser"), at(["good"], "pass")];
const baseReports = [at(["broke"], "pass"), at(["env"], "fail", "no browser"), at(["good"], "pass")];
const ran = { status: "ran", runner: "node", isolation: "bwrap", seconds: 1, exitCode: 1, reports: headReports, deleted: [], edited: [] } as const;

test("the document gives each head test its verdict and counts them; the head's own counts stay", () => {
  const document = observedDocument({ ...ran, control: { status: "ran", seconds: 2, reports: baseReports } }, graph, "t") as RanObserved;
  expect(document.counts).toEqual({ pass: 1, fail: 2, skip: 0 });
  expect(document.control).toMatchObject({ status: "ran", seconds: 2, counts: { regression: 1, environment: 1, passes: 1 }, baseOnly: [] });
  const verdicts = Object.values(document.tests).flat().map((test) => [test.name, test.verdict]);
  expect(verdicts).toEqual([["broke", "regression"], ["env", "environment"], ["good", "passes"]]);
});

test("the report's failures are the regressions; the environment failures are listed apart and the full list stays reachable", () => {
  const document = observedDocument({ ...ran, control: { status: "ran", seconds: 2, reports: baseReports } }, graph, "t") as RanObserved;
  const report = observedReport(document, graph, comparison);
  expect(report.failing.map((test) => test.name)).toEqual(["broke"]);
  expect(report.others.map((test) => [test.name, test.verdict])).toEqual([["env", "environment"]]);
  expect(report.failingFiles).toEqual(new Set(["file:test/a.test.mjs"]));
  expect(report.control).toEqual({ status: "ran" });
  const onlyEnv = observedDocument({ ...ran, reports: [headReports[1]!, headReports[2]!], control: { status: "ran", seconds: 2, reports: baseReports } }, graph, "t") as RanObserved;
  const quiet = observedReport(onlyEnv, graph, comparison);
  expect(quiet.failing).toEqual([]);
  expect(quiet.failingFiles.size).toBe(0);
});

test("a control run that failed, stopped or could not run leaves the head's failures as they are, labelled, with no verdicts and no regression count", () => {
  for (const control of [
    { status: "failed", why: "the run passed its limit of 600 seconds", output: "" },
    { status: "stopped", why: "the control run stopped: boom" },
    { status: "unsupported", why: "main has no test script" },
  ] as const) {
    const document = observedDocument({ ...ran, control }, graph, "t") as RanObserved;
    expect(document.control).toMatchObject({ status: control.status, why: control.why });
    expect(JSON.stringify(document)).not.toContain("regression");
    expect(Object.values(document.tests).flat().every((test) => test.verdict === undefined)).toBe(true);
    const report = observedReport(document, graph, comparison);
    expect(report.failing.map((test) => test.name)).toEqual(["broke", "env"]);
    expect(report.others).toEqual([]);
    expect(report.control).toEqual({ status: control.status, why: control.why });
  }
});

test("a run with no control at all is a run with no control run, never zero regressions", () => {
  const document = observedDocument(ran, graph, "t") as RanObserved;
  expect(document.control).toMatchObject({ status: "stopped", why: "not attempted" });
});

test("a skipped main test is no evidence that a file worked: a crash of such a file is failed and not compared", () => {
  const crash: TestReport = { file: "test/b.test.mjs", path: ["test/b.test.mjs"], outcome: "fail", ms: 1 };
  expect(classify([crash], [{ file: "test/b.test.mjs", path: ["a"], outcome: "skip", ms: 0 }]).verdicts).toEqual(["head only"]);
});

const fileDocument = (headReports: TestReport[], baseReports: TestReport[]) => observedDocument({ ...ran, reports: headReports, control: { status: "ran", seconds: 1, reports: baseReports } }, graph, "t") as RanObserved;
const added = compare(extract(new Map()), graph);
const row = (document: RanObserved) => observedReport(document, graph, added).files.find((file) => file.path === "test/a.test.mjs")!;

test("a file row's counts come from the verdicts: passes are passed on both, the rest are counted apart", () => {
  const document = fileDocument(
    [at(["p"], "pass"), at(["s"], "pass"), at(["f"], "pass"), at(["h"], "pass"), at(["r"], "fail")],
    [at(["p"], "pass"), at(["s"], "skip"), at(["f"], "fail"), at(["gone"], "pass"), at(["r"], "pass")],
  );
  expect(row(document)).toMatchObject({ counts: { pass: 1, fail: 1, skip: 0 }, fixed: 1, notCompared: 3 });
});

test("a file's mark is a tick only when everything compared passed on both; environment alone is a cross, mixed takes the worst", () => {
  const mark = (head: TestReport[], base: TestReport[]) => fileMark(row(fileDocument(head, base)));
  expect(mark([at(["a"], "pass")], [at(["a"], "pass")])).toBe("pass");
  expect(mark([at(["a"], "fail")], [at(["a"], "fail")])).toBe("fail");
  expect(mark([at(["a"], "pass"), at(["b"], "fail")], [at(["a"], "pass"), at(["b"], "fail")])).toBe("fail");
  expect(mark([at(["a"], "pass"), at(["b"], "pass")], [at(["a"], "pass"), at(["b"], "skip")])).toBe("skip");
  expect(mark([at(["a"], "pass")], [at(["a"], "fail")])).toBe("skip");
});

test("tests only main has are listed as base only and counted as neither a pass nor a regression", () => {
  const document = observedDocument({ ...ran, reports: [headReports[2]!], control: { status: "ran", seconds: 1, reports: baseReports } }, graph, "t") as RanObserved;
  expect(document.control).toMatchObject({ status: "ran", counts: { regression: 0, "base only": 2, passes: 1 } });
  expect(document.control.status === "ran" && document.control.baseOnly.map((test) => test.name)).toEqual(["broke", "env"]);
});

// The control run's tree is read-only like the head run's, which can make a main test fail that never failed on main before. Such a failure says nothing about the PR's.
const EROFS = "EROFS: read-only file system, open 'result.txt'";
const READ_ONLY_REASON = "main's run met a read-only file system error, which the read-only tree causes: not compared with main";

test("a main failure that is a read-only file system error does not make the PR's failure environment, or its pass fixed: both are unclear, with the reason", () => {
  const { verdicts, reasons, counts } = classify([at(["a"], "fail", "10 !== 11"), at(["b"], "pass"), at(["c"], "fail", "boom")], [at(["a"], "fail", EROFS), at(["b"], "fail", EROFS), at(["c"], "fail", "boom")]);
  expect(verdicts).toEqual(["unclear", "unclear", "environment"]);
  expect(reasons).toEqual([READ_ONLY_REASON, READ_ONLY_REASON, undefined]);
  expect(counts).toMatchObject({ regression: 0, environment: 1, fixed: 0, unclear: 2 });
});

test("a read-only file system error is found wherever the main failure carries it: the message in any case, the assertion's values, its code", () => {
  const head = [at(["a"], "fail", "x")];
  const base = (report: Partial<TestReport>): TestReport[] => [{ ...at(["a"], "fail", "could not save"), ...report }];
  expect(classify(head, base({ message: "ENOENT then erofs: Read-Only File System" })).verdicts).toEqual(["unclear"]);
  expect(classify(head, base({ detail: { actual: "{ code: 'EROFS' }", expected: "undefined" } })).verdicts).toEqual(["unclear"]);
  expect(classify(head, base({ detail: { expected: "'read-only file system'" } })).verdicts).toEqual(["unclear"]);
  expect(classify(head, base({})).verdicts).toEqual(["environment"]);
});

test("a main run whose output names a read-only file system makes none of its failures an environment verdict", () => {
  const { verdicts, reasons } = classify([at(["a"], "fail", "x"), at(["b"], "fail", "y")], [at(["a"], "fail", "could not save"), at(["b"], "fail", "y")], READ_ONLY_REASON);
  expect(verdicts).toEqual(["unclear", "unclear"]);
  expect(reasons).toEqual([READ_ONLY_REASON, READ_ONLY_REASON]);
  // Main's passes are still passes: only a failure on main is in doubt.
  expect(classify([at(["a"], "fail", "x")], [at(["a"], "pass")], READ_ONLY_REASON).verdicts).toEqual(["regression"]);
});

test("the document carries the reason beside the verdict, and the report lists the failure as not held against the PR but not exonerated", () => {
  const document = fileDocument([at(["broke"], "fail", "10 !== 11")], [at(["broke"], "fail", EROFS)]);
  const [test] = Object.values(document.tests).flat();
  expect(test).toMatchObject({ verdict: "unclear", verdictWhy: READ_ONLY_REASON });
  const report = observedReport(document, graph, added);
  expect(report.failing).toEqual([]);
  expect(report.others).toEqual([expect.objectContaining({ name: "broke", verdict: "unclear", verdictWhy: READ_ONLY_REASON })]);
});
