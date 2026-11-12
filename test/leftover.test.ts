import { expect, test } from "vitest";
import { leftoverRunning, leftoverText, leftoverWarns, mergeLeftovers } from "../src/leftover.ts";
import type { Leftover } from "../src/leftover.ts";

const none: Leftover = { strays: [], more: 0, held: false };
const killed = { pid: 4242, name: "node", killed: true };
const alive = { pid: 77, name: "sh", killed: false };

test("a process left behind and killed is named with its pid, and says it was killed", () => {
  expect(leftoverText({ ...none, strays: [killed] })).toBe("left behind: node (pid 4242) killed");
  expect(leftoverText({ ...none, strays: [killed, { pid: 4243, name: "sleep", killed: true }] })).toBe("left behind: node (pid 4242), sleep (pid 4243) killed");
});

test("a process that could not be killed is said plainly, as still running, and is a warning", () => {
  const left = { ...none, strays: [alive] };
  expect(leftoverText(left)).toBe("left behind: sh (pid 77) not killable, still running on this machine");
  expect(leftoverWarns(left)).toBe(true);
  expect(leftoverText({ ...none, strays: [killed, alive] })).toBe("left behind: node (pid 4242) killed; left behind: sh (pid 77) not killable, still running on this machine");
});

test("a killed process is worth saying but is not a warning", () => {
  expect(leftoverWarns({ ...none, strays: [killed] })).toBe(false);
});

test("a check that could not run says the leftovers were not checked, never that none were left", () => {
  const left = { ...none, notChecked: "this machine has no /proc to read" };
  expect(leftoverText(left)).toBe("leftovers not checked (this machine has no /proc to read)");
  expect(leftoverText(left)).not.toMatch(/no process left behind|none left/);
  expect(leftoverWarns(left)).toBe(true);
});

test("only a check that ran and found nothing says no process was left behind", () => {
  expect(leftoverText(none)).toBe("no process left behind");
  expect(leftoverWarns(none)).toBe(false);
});

test("output held open by something that could not be found is a warning: it may still be running", () => {
  const left = { ...none, held: true };
  expect(leftoverText(left)).toBe("a process the step started kept its output open and could not be found, so it may still be running");
  expect(leftoverWarns(left)).toBe(true);
});

test("a check that did not run beside processes it did find says both", () => {
  expect(leftoverText({ ...none, strays: [killed], notChecked: "no /proc" })).toBe("left behind: node (pid 4242) killed; leftovers not checked (no /proc)");
});

test("processes past the listing are counted, never dropped, and are a warning", () => {
  const left = { ...none, strays: [killed], more: 3 };
  expect(leftoverText(left)).toBe("left behind: node (pid 4242) killed; 3 more left behind, not listed (not known whether killed)");
  expect(leftoverWarns(left)).toBe(true);
});

test("merging the steps of a run: none known stays unknown, one unchecked step keeps the whole run unchecked", () => {
  // A sandboxed step has no leftover to report: the namespace ends with it.
  expect(mergeLeftovers([undefined, undefined])).toBeUndefined();
  expect(mergeLeftovers([])).toBeUndefined();
  expect(mergeLeftovers([none, none])).toEqual(none);
  expect(mergeLeftovers([none, { ...none, notChecked: "no /proc" }])).toEqual({ ...none, notChecked: "no /proc" });
  expect(mergeLeftovers([{ ...none, strays: [killed] }, undefined, { ...none, strays: [alive], held: true }])).toEqual({ strays: [killed, alive], more: 0, held: true });
  // The same step's process found twice is one process.
  expect(mergeLeftovers([{ ...none, strays: [killed] }, { ...none, strays: [killed] }])?.strays).toEqual([killed]);
  // Two different reasons are both kept.
  expect(mergeLeftovers([{ ...none, notChecked: "a" }, { ...none, notChecked: "b" }])?.notChecked).toBe("a; b");
});

test("a merged list is capped and counts what it left out", () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ pid: 1000 + index, name: "node", killed: true }));
  const merged = mergeLeftovers([{ ...none, strays: many }]);
  expect(merged?.strays).toHaveLength(20);
  expect(merged?.more).toBe(10);
  expect(merged?.moreAlive).toBe(0);
});

test("21 processes all killed is not a process left running: the cut list keeps how many were not killed", () => {
  const many = Array.from({ length: 21 }, (_, index) => ({ pid: 1000 + index, name: "sleep", killed: true }));
  const merged = mergeLeftovers([{ ...none, strays: many }]);
  expect(merged).toMatchObject({ more: 1, moreAlive: 0 });
  expect(merged?.strays).toHaveLength(20);
  expect(leftoverWarns(merged as Leftover)).toBe(false);
  expect(leftoverRunning(merged as Leftover)).toBe(false);
  expect(leftoverText(merged as Leftover)).toContain("1 more left behind, not listed (all killed)");
});

test("a process that could not be killed is listed first, so a cut list never hides it past the cap", () => {
  const many = Array.from({ length: 25 }, (_, index) => ({ pid: 1000 + index, name: "sleep", killed: index !== 24 }));
  const merged = mergeLeftovers([{ ...none, strays: many }]) as Leftover;
  expect(merged.strays[0]).toMatchObject({ pid: 1024, killed: false });
  expect(merged.moreAlive).toBe(0);
  expect(leftoverRunning(merged)).toBe(true);
  // More not-killable ones than the list holds: the rest are counted, and still say they are running.
  const alive = Array.from({ length: 23 }, (_, index) => ({ pid: 2000 + index, name: "sleep", killed: false }));
  const cut = mergeLeftovers([{ ...none, strays: alive }]) as Leftover;
  expect(cut).toMatchObject({ more: 3, moreAlive: 3 });
  expect(leftoverText(cut)).toContain("3 more left behind, not listed (3 not killable, still running)");
  expect(leftoverWarns(cut)).toBe(true);
});

test("a cut list merged again keeps what it counted: the kill outcomes of names already cut are not lost", () => {
  const first = mergeLeftovers([{ ...none, strays: Array.from({ length: 22 }, (_, index) => ({ pid: 3000 + index, name: "sleep", killed: index !== 0 })) }]) as Leftover;
  expect(first).toMatchObject({ more: 2, moreAlive: 0 });
  const again = mergeLeftovers([first, { ...none, strays: [{ pid: 4000, name: "node", killed: true }] }]) as Leftover;
  expect(again.strays).toHaveLength(20);
  expect(again.more).toBe(3);
  expect(again.moreAlive).toBe(0);
  expect(mergeLeftovers([{ ...first, moreAlive: 1 }])).toMatchObject({ more: 2, moreAlive: 1 });
});

test("names cut with no count of their kill outcomes are not known killed: they warn", () => {
  expect(leftoverWarns({ ...none, more: 2 })).toBe(true);
  expect(leftoverText({ ...none, more: 2 })).toBe("2 more left behind, not listed (not known whether killed)");
});
