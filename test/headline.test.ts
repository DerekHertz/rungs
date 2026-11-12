import { expect, test } from "vitest";
import { headline, headlineTitle } from "../src/headline.ts";
import type { Comparison } from "../src/compare.ts";
import type { ObservedDocument } from "../src/observed-types.ts";
import type { TestChanges } from "../src/test-changes-types.ts";

const none = { extractorVersion: "x", changes: [], effects: [], changedEffects: [], imports: [], sections: [], dependencies: [], unread: [] } as unknown as Comparison;
const noTests = { deletedFiles: [], removedTests: [], renamed: [], markers: [], weakened: [] } as TestChanges;
const change = (level: string, kind = "altered") => ({ kind, node: { level } });
const nothing = { regression: 0, environment: 0, fixed: 0, passes: 0, skipped: 0, "head only": 0, "base only": 0, unclear: 0 };
const ran = (pass: number, fail: number, control: unknown = { status: "ran", seconds: 1, counts: { ...nothing, regression: fail, passes: pass }, baseOnly: [] }): ObservedDocument =>
  ({ tier: "observed", tree: "t", status: "ran", counts: { pass, fail, skip: 0 }, control }) as unknown as ObservedDocument;
const doc = (status: string): ObservedDocument => ({ tier: "observed", tree: "t", status, why: "x" }) as unknown as ObservedDocument;

test("a change with nothing else says it changed no code, and that the tests were not run, never a test count", () => {
  expect(headline(none, noTests, null)).toBe("no code changed · tests not run");
});

test("new and altered are told apart, as the district labels do, and removed or moved only when there are some", () => {
  const comparison = { ...none, changes: [change("file", "added"), change("file"), change("file"), change("function", "added"), change("function", "added"), change("class"), change("constant", "removed")] } as unknown as Comparison;
  expect(headline(comparison, noTests, null)).toBe("files 1 new · 2 altered · code 2 new · 1 altered · 1 removed · tests not run");
});

test("the headline counts calls, argument changes, imports, dependencies and removed tests", () => {
  const comparison = {
    ...none,
    changes: [change("file")],
    effects: [{ kind: "added" }, { kind: "added" }, { kind: "removed" }],
    changedEffects: [{ count: 2, calls: [{}, {}] }, { count: 1, calls: [{}] }],
    imports: [{ kind: "added" }],
    dependencies: [{ kind: "added" }],
  } as unknown as Comparison;
  const removed = { ...noTests, removedTests: [{ file: "a", name: "b" }], deletedFiles: [{ path: "t", tests: 3 }] } as TestChanges;
  expect(headline(comparison, removed, ran(27, 0))).toBe(
    "files 1 altered · calls +2 −1 · 3 calls changed arguments · imports +1 · 1 dependency changed · 1 test name removed \u00b7 tests in deleted files: 3 · main's tests: 27 passed",
  );
});

test("failing, unfinished and unreliable runs are said as what they are, and no count appears without a run", () => {
  expect(headline(none, noTests, ran(5, 2))).toContain("main's tests: 2 regressions, 5 passed");
  expect(headline(none, noTests, doc("failed"))).toContain("tests did not finish");
  expect(headline(none, noTests, doc("unreliable"))).toContain("test results unreliable");
  expect(headline(none, noTests, doc("refused"))).toContain("tests not run");
  expect(headline(none, noTests, { tier: "observed", tree: "t", status: "running", stage: "tests" })).toContain("tests running…");
  expect(headline(none, noTests, { tier: "observed", tree: "t", status: "stopped", why: "x" })).toContain("tests not run: x");
});

test("with a control run the tests part counts regressions only, and says what else failed", () => {
  const control = (over: object) => ({ status: "ran", seconds: 1, counts: { ...nothing, passes: 130, ...over }, baseOnly: [] });
  expect(headline(none, noTests, ran(130, 8, control({ regression: 2, environment: 6 })))).toContain("main's tests: 2 regressions, 6 environment, 130 passed");
  expect(headline(none, noTests, ran(130, 6, control({ environment: 6 })))).toContain("main's tests: no regressions, 6 environment, 130 passed");
  expect(headline(none, noTests, ran(130, 1, control({ regression: 1 })))).toContain("main's tests: 1 regression, 130 passed");
  expect(headline(none, noTests, ran(130, 3, control({ environment: 1, skipped: 2 })))).toContain("main's tests: no regressions, 1 environment, 2 not compared, 130 passed");
  // Counts come from the verdicts: a test skipped on main, one only the PR reported, or one named twice did not pass on both.
  expect(headline(none, noTests, ran(130, 0, control({ passes: 127, skipped: 1, "head only": 1, unclear: 1 })))).toContain("main's tests: no regressions, 3 not compared, 127 passed");
  expect(headline(none, noTests, ran(130, 0, control({ passes: 129, fixed: 1 })))).toContain("main's tests: no regressions, 1 fixed, 129 passed");
});

test("a control run that gave no results leaves the head's failures, labelled, and never says zero regressions", () => {
  for (const status of ["failed", "stopped", "unreliable", "unsupported", "refused"]) {
    const line = headline(none, noTests, ran(5, 2, { status, why: "it broke" }));
    expect(line).toContain("main's tests: 2 failed, 5 passed (no control run: it broke)");
    expect(line).not.toContain("regression");
  }
  expect(headline(none, noTests, ran(5, 0, { status: "failed", why: "it broke" }))).toContain("main's tests: 5 passed");
});

test("while the control run is under way the part says so, never a partial verdict", () => {
  expect(headline(none, noTests, { tier: "observed", tree: "t", status: "running", stage: "control" })).toContain("running the control run…");
  expect(headline(none, noTests, { tier: "observed", tree: "t", status: "running", stage: "tests" })).toContain("tests running…");
});

test("a test only main ran is not a pass of the PR's run: it is counted as not compared", () => {
  const counts = { ...nothing, passes: 129, "base only": 1 };
  expect(headline(none, noTests, ran(129, 0, { status: "ran", seconds: 1, counts, baseOnly: [] }))).toContain("main's tests: no regressions, 1 not compared, 129 passed");
});

test("a change of only dependencies is not said to change no code", () => {
  expect(headline({ ...none, dependencies: [{ kind: "added" }] } as unknown as Comparison, noTests, null)).toBe("1 dependency changed · tests not run");
});

test("a resolution call that is new, gone or changed is not said to be a call whose arguments changed", () => {
  const comparison = { ...none, changedEffects: [{ count: 1, calls: [], added: ['"x"'], removed: [] }] } as unknown as Comparison;
  const line = headline(comparison, noTests, null);
  expect(line).toContain("1 resolution changed");
  expect(line).not.toContain("changed arguments");
});

test("tests that ran without a sandbox say so in the line and in the hover", () => {
  const unsandboxed = { ...ran(3, 0), sandbox: "unsandboxed" } as unknown as ObservedDocument;
  expect(headline(none, noTests, unsandboxed)).toContain("main's tests: 3 passed (ran without a sandbox)");
  expect(headlineTitle("x", unsandboxed)).toContain("as trustworthy as the PR's author");
  expect(headlineTitle("x", ran(3, 0))).toBe("x");
});

test("removed tests are counted as names, since two tests of one name are one lost name", () => {
  const removed = { ...noTests, removedTests: [{ file: "a", name: "same" }] } as TestChanges;
  expect(headline(none, removed, null)).toContain("1 test name removed");
  expect(headline(none, removed, null)).not.toContain("1 test removed");
});

test("a deleted test file whose tests were not read makes the count unknown, never a total", () => {
  const removed = { ...noTests, deletedFiles: [{ path: "test/a.test.mjs", tests: 1 }, { path: "test/test_b.py", tests: 0 }] } as TestChanges;
  expect(headline(none, removed, null)).toContain("tests in deleted files: 1 + unknown");
  const only = { ...noTests, deletedFiles: [{ path: "test/test_b.py", tests: 0 }] } as TestChanges;
  expect(headline(none, only, null)).toContain("tests in deleted files: unknown");
});

test("a test file that left test discovery but still exists is counted apart, never called deleted", () => {
  const removed = { ...noTests, deletedFiles: [{ path: "test/a.test.mjs", tests: 4 }, { path: "test/b.test.mjs", tests: 2, movedTo: "scripts/b.mjs" }] } as TestChanges;
  const line = headline(none, removed, null);
  expect(line).toContain("tests in deleted files: 4");
  expect(line).toContain("tests moved out of test discovery: 2");
});
