import { expect, test } from "vitest";
import { headline, headlineTitle } from "../src/headline.ts";
import type { Comparison } from "../src/compare.ts";
import type { ObservedDocument } from "../src/observed-types.ts";
import type { TestChanges } from "../src/test-changes-types.ts";

const none = { extractorVersion: "x", changes: [], effects: [], changedEffects: [], imports: [], sections: [], dependencies: [] } as unknown as Comparison;
const noTests = { deletedFiles: [], removedTests: [], renamed: [], markers: [], weakened: [] } as TestChanges;
const change = (level: string, kind = "altered") => ({ kind, node: { level } });
const ran = (pass: number, fail: number): ObservedDocument => ({ tier: "observed", tree: "t", status: "ran", counts: { pass, fail, skip: 0 } }) as unknown as ObservedDocument;
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
    "files 1 altered · calls +2 −1 · 3 calls changed arguments · imports +1 · 1 dependency changed · 1 test name removed \u00b7 3 tests in deleted files · main's tests: 27 passed",
  );
});

test("failing, unfinished and unreliable runs are said as what they are, and no count appears without a run", () => {
  expect(headline(none, noTests, ran(5, 2))).toContain("main's tests: 2 failed, 5 passed");
  expect(headline(none, noTests, doc("failed"))).toContain("tests did not finish");
  expect(headline(none, noTests, doc("unreliable"))).toContain("test results unreliable");
  expect(headline(none, noTests, doc("refused"))).toContain("tests not run");
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
