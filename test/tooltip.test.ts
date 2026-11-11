import { describe, expect, test } from "vitest";
import { tooltipPosition } from "../src/page/tooltip.ts";

describe("tooltipPosition", () => {
  const view = { width: 1000, height: 800 };
  test("sits a little below and right of the pointer", () => {
    expect(tooltipPosition({ x: 100, y: 200 }, { width: 120, height: 40 }, view)).toEqual({ left: 116, top: 216 });
  });
  test("keeps clear of the window's right and bottom edges", () => {
    expect(tooltipPosition({ x: 990, y: 790 }, { width: 120, height: 40 }, view)).toEqual({ left: 876, top: 756 });
  });
  test("follows the pointer, never a previous position", () => {
    const at = (x: number) => tooltipPosition({ x, y: 10 }, { width: 50, height: 20 }, view).left;
    expect(at(10)).not.toBe(at(300));
  });
});
