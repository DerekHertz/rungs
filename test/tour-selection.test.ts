import { expect, test } from "vitest";
import { enterStop, leaveTour, stopRow } from "../src/tour-selection.ts";

const rows = [
  { ids: ["fn:src/a.ts#alpha"], path: "src/a.ts" },
  { ids: ["file:src/b.ts"], path: "src/b.ts" },
  { ids: ["fn:src/b.ts#beta"], path: "src/b.ts" },
];

test("a stop selects the row naming one of its node ids", () => {
  expect(stopRow(["fn:src/b.ts#beta"], ["src/b.ts"], rows)).toBe(2);
});

test("with no id match, a stop selects the first row about one of its files", () => {
  expect(stopRow(["fn:src/other.ts#x"], ["src/b.ts"], rows)).toBe(1);
});

test("a stop with no row for its ids or files selects nothing", () => {
  expect(stopRow(["fn:src/c.ts#c"], ["src/c.ts"], rows)).toBeUndefined();
  expect(stopRow([], [], rows)).toBeUndefined();
});

test("the manual selection is saved at the first stop only, and restored once on close", () => {
  let state = enterStop(undefined, () => "manual");
  state = enterStop(state, () => "the tour's own");
  const left = leaveTour(state);
  expect(left.restore).toEqual({ value: "manual" });
  expect(left.state).toBeUndefined();
  expect(leaveTour(left.state).restore).toBeUndefined();
});

test("a manual selection of nothing is still restored", () => {
  expect(leaveTour(enterStop(undefined, () => undefined)).restore).toEqual({ value: undefined });
});

test("the saved value is not read again while the tour is open", () => {
  let reads = 0;
  const state = enterStop(undefined, () => ++reads);
  enterStop(state, () => ++reads);
  expect(reads).toBe(1);
});
