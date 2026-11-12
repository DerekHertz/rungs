import { expect, test } from "vitest";
import { comparedLine, failingEntry, failingHeading, walkEntry } from "../src/arrival.ts";
import { walkStatus, walkSummary } from "../src/stops.ts";

const dropped = { stops: 0, ids: 0, claims: 0, sentences: 1 };
const ok = { status: "ok", model: "claude-opus-5-5", promptVersion: "tour-v1", dropped, cached: true } as const;

test("while the tests run the entry says so and is not a count of failures", () => {
  expect(failingEntry("running", 0)).toMatchObject({ label: "running tests…", enabled: false });
  expect(failingEntry("stopped", 0)).toMatchObject({ label: "Tests not run", enabled: false });
});

test("while the control run goes the entry says so, and a run with no control run labels the head's failures", () => {
  expect(failingEntry("running", 0, { stage: "control" })).toMatchObject({ label: "running the control run…", enabled: false });
  expect(failingEntry("running", 0, { stage: "tests" })).toMatchObject({ label: "running tests…", enabled: false });
  expect(failingEntry("ran", 8, { noControl: "the run passed its limit" })).toMatchObject({ label: "Inspect 8 failing tests (no control run: the run passed its limit)", enabled: true });
  expect(failingEntry("ran", 0, { noControl: "x" }).label).not.toContain("regression");
});

test("with a control run the entry counts regressions, and a run of only environment failures says so and keeps the list reachable", () => {
  expect(failingEntry("ran", 2, { others: 6 })).toMatchObject({ label: "Inspect 2 failing tests", enabled: true });
  expect(failingEntry("ran", 0, { others: 6 })).toMatchObject({ label: "No regressions (6 other results)", enabled: true });
  expect(failingEntry("ran", 0, { others: 0 })).toMatchObject({ label: "No failing tests", enabled: false });
});

test("the compared line names the repository and the comparison target, and holds without a repository", () => {
  expect(comparedLine("docviz", { ref: "pr14-base", commit: "31163ce".padEnd(40, "0") })).toBe("docviz against pr14-base at 31163ce (merge base)");
  expect(comparedLine(null, { ref: "main", commit: "abcdef0123" })).toBe("against main at abcdef0 (merge base)");
});

test("the tests entry counts failures, and says so honestly with none, with a failed run, and without a run", () => {
  expect(failingEntry("ran", 8)).toMatchObject({ label: "Inspect 8 failing tests", enabled: true });
  expect(failingEntry("ran", 1)).toMatchObject({ label: "Inspect 1 failing test", enabled: true });
  expect(failingEntry("ran", 0)).toMatchObject({ label: "No failing tests", enabled: false });
  expect(failingEntry("absent", 0)).toMatchObject({ label: "Tests not run", enabled: false });
  expect(failingEntry("refused", 0)).toMatchObject({ label: "Tests not run", enabled: false });
  expect(failingEntry("failed", 0)).toMatchObject({ label: "Tests did not finish", enabled: false });
  expect(failingEntry("unreliable", 0)).toMatchObject({ label: "Test results unreliable", enabled: false });
});

test("the tour entry says how many changed files it walks through, and why there is no tour", () => {
  expect(walkEntry(ok, 11, { covered: 8, changed: 8 })).toMatchObject({ label: "Walk through 8 changed files", enabled: true });
  expect(walkEntry(ok, 3, { covered: 5, changed: 8 })).toMatchObject({ label: "Walk through 5 of 8 changed files", enabled: true });
  expect(walkEntry(ok, 1, { covered: 1, changed: 1 })).toMatchObject({ label: "Walk through 1 changed file" });
  expect(walkEntry(ok, 0, { covered: 0, changed: 8 })).toMatchObject({ label: "No walkthrough stops", enabled: false });
  expect(walkEntry({ status: "off" }, 0, { covered: 0, changed: 8 })).toMatchObject({ label: "No walkthrough", enabled: false });
  expect(walkEntry({ status: "failed", message: "no claude" }, 0, { covered: 0, changed: 8 })).toMatchObject({ label: "No walkthrough", enabled: false });
});

test("the Failing heading puts the provenance beside the count", () => {
  expect(failingHeading(8)).toBe("8 failures running main's tests against this PR");
  expect(failingHeading(1)).toBe("1 failure running main's tests against this PR");
  expect(failingHeading(0)).toBe("No test failed running main's tests against this PR");
  expect(failingHeading(2, true)).toBe("2 regressions: tests that pass on main and fail with this PR");
  expect(failingHeading(1, true)).toBe("1 regression: a test that passes on main and fails with this PR");
  expect(failingHeading(0, true)).toBe("No regressions: no test passes on main and fails with this PR");
});

test("the footer status is the stop count, and the diagnostics stay in the summary", () => {
  expect(walkStatus(ok, 11)).toBe("11 stops");
  expect(walkStatus(ok, 1)).toBe("1 stop");
  expect(walkStatus({ status: "off" }, 0)).toBe(walkSummary({ status: "off" }, 0));
  expect(walkSummary(ok, 11)).toContain("claude-opus-5-5");
});

test("the entry and the heading never say no regressions while a head failure is not compared", () => {
  expect(failingEntry("ran", 0, { others: 1, uncompared: 1 })).toMatchObject({ label: "No regression found (1 failure not compared)", enabled: true });
  expect(failingEntry("ran", 0, { others: 3, uncompared: 2 }).label).toBe("No regression found (2 failures not compared)");
  expect(failingEntry("ran", 0, { others: 3, uncompared: 2 }).note).not.toMatch(/^No test passes on main and fails/);
  expect(failingHeading(0, true, 1)).toBe("No regression found: 1 failure not compared with main");
  expect(failingHeading(0, true, 3)).toBe("No regression found: 3 failures not compared with main");
  expect(failingHeading(0, true)).toBe("No regressions: no test passes on main and fails with this PR");
});
