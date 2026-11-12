import { expect, test } from "vitest";
import { MIN_GAP_MS, POLL_MS, mayCheck } from "../src/picker-timing.ts";

test("the badge polls every few minutes, and no two checks are closer than the minimum gap", () => {
  expect(POLL_MS).toBeGreaterThanOrEqual(2 * 60 * 1000);
  expect(MIN_GAP_MS).toBeGreaterThanOrEqual(30 * 1000);
  expect(mayCheck(1_000_000, null, false)).toBe(true);
});

test("a check never starts while one is in flight, nor inside the gap after the last (focus flapping is not a loop)", () => {
  expect(mayCheck(1_000_000, 1_000_000 - MIN_GAP_MS + 1, false)).toBe(false);
  expect(mayCheck(1_000_000, 1_000_000 - MIN_GAP_MS, false)).toBe(true);
  expect(mayCheck(1_000_000, null, true)).toBe(false);
  expect(mayCheck(1_000_000, 0, true)).toBe(false);
});
