import { expect, test } from "vitest";
import { observedAbout, observedNote } from "../src/observed-text.ts";
import type { Leftover } from "../src/leftover.ts";
import type { ObservedDocument } from "../src/observed-types.ts";

const counts = { pass: 1, fail: 0, skip: 0 };
const control = { status: "stopped", why: "not attempted" } as const;
const ran = (sandbox: "bwrap" | "unsandboxed", leftover?: Leftover): ObservedDocument => ({
  tier: "observed",
  tree: "t",
  status: "ran",
  runner: "node",
  sandbox,
  seconds: 1,
  exitCode: 0,
  counts,
  control,
  tests: {},
  unmatched: [],
  deleted: [],
  edited: [],
  written: null,
  ...(leftover === undefined ? {} : { leftover }),
});
const failed = (leftover?: Leftover): ObservedDocument => ({ tier: "observed", tree: "t", status: "failed", why: "the run passed its limit", runner: "node", sandbox: "unsandboxed", seconds: 3, output: "", ...(leftover === undefined ? {} : { leftover }) });

const killed: Leftover = { strays: [{ pid: 4242, name: "node", killed: true }], more: 0, held: false };
const stuck: Leftover = { strays: [{ pid: 77, name: "node", killed: false }], more: 0, held: false };
const unchecked: Leftover = { strays: [], more: 0, held: false, notChecked: "this machine has no /proc to read" };
const clean: Leftover = { strays: [], more: 0, held: false };

test("the Tests row's note and the About note name a killed leftover process", () => {
  const document = ran("unsandboxed", killed);
  expect(observedNote(document)).toContain("Left behind: node (pid 4242) killed.");
  expect(observedAbout(document)[0]?.[1]).toContain("Left behind: node (pid 4242) killed.");
});

test("a leftover process that could not be killed is said plainly in both notes", () => {
  const document = ran("unsandboxed", stuck);
  expect(observedNote(document)).toContain("Left behind: node (pid 77) not killable, still running on this machine.");
  expect(observedAbout(document)[0]?.[1]).toContain("not killable");
});

test("a leftover check that could not run says so in both notes, and never says none were left", () => {
  const document = ran("unsandboxed", unchecked);
  for (const text of [observedNote(document), observedAbout(document)[0]?.[1] ?? ""]) {
    expect(text).toContain("Leftovers not checked (this machine has no /proc to read).");
    expect(text).not.toMatch(/no process left behind/i);
  }
});

test("an unsandboxed run whose check found nothing says no process was left behind", () => {
  expect(observedNote(ran("unsandboxed", clean))).toContain("No process left behind.");
});

test("a run that failed or was unreliable says what was left behind too", () => {
  expect(observedAbout(failed(stuck))[0]?.[1]).toContain("not killable");
  expect(observedNote(failed(unchecked))).toContain("Leftovers not checked");
});

test("a sandboxed run has no leftover line: its namespace ends with each step", () => {
  const note = observedNote(ran("bwrap"));
  expect(note).not.toMatch(/left behind|leftovers/i);
});

test("an unsandboxed run says its results are weaker: one test can rewrite the files another test reads", () => {
  const note = observedNote(ran("unsandboxed", clean));
  expect(note).toContain("ran without a sandbox: as trustworthy as the PR's author");
  expect(note).toContain("one test can rewrite the code and test files another test reads");
  expect(observedNote(ran("bwrap"))).not.toContain("rewrite");
});

test("a sandboxed run says its tree was read-only and its scratch folder shared", () => {
  expect(observedAbout(ran("bwrap"))[0]?.[1]).toContain("the tree read-only");
  expect(observedAbout(ran("bwrap"))[0]?.[1]).toContain("one scratch folder");
});
