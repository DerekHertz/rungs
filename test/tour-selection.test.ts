import { expect, test } from "vitest";
import { enterStop, leaveTour, stopRow } from "../src/tour-selection.ts";

const rows = [
  { ids: ["fn:src/a.ts#alpha"], path: "src/a.ts" },
  { ids: ["file:src/b.ts"], path: "src/b.ts" },
  { ids: ["fn:src/b.ts#beta"], path: "src/b.ts" },
];

const fn = (id: string, path: string) => ({ id, path, level: "function" });
const file = (path: string) => ({ id: `file:${path}`, path, level: "file" });

test("a stop selects the row naming one of its node ids", () => {
  expect(stopRow([fn("fn:src/b.ts#beta", "src/b.ts")], rows)).toBe(2);
});

test("a stop at a file node with no id match selects the first row about that file", () => {
  expect(stopRow([file("src/b.ts")], [{ ids: ["fn:src/b.ts#beta"], path: "src/b.ts" }])).toBe(0);
});

test("a stop at a block does not take another block's risk in the same file", () => {
  expect(stopRow([fn("fn:src/a.ts#beta", "src/a.ts")], rows)).toBeUndefined();
});

test("a stop with no row for its ids or files selects nothing", () => {
  expect(stopRow([file("src/c.ts")], rows)).toBeUndefined();
  expect(stopRow([], rows)).toBeUndefined();
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
