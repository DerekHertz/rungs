import { expect, test } from "vitest";
import { pickAt } from "../src/town-pick.ts";
import type { Placement, Plaque } from "../src/town-pick.ts";

const solid = () => true;

test("a name is a target for its own building, ahead of the sprites over it", () => {
  const sprites: Placement<string>[] = [
    { thing: "a.js", box: { x: 0, y: 0, w: 100, h: 100 }, cols: 100, rows: 100 },
    { thing: "d.js", box: { x: 40, y: 20, w: 100, h: 100 }, cols: 100, rows: 100 },
  ];
  const names: Plaque<string>[] = [{ thing: "a.js", box: { x: 30, y: 30, w: 60, h: 14 } }];
  expect(pickAt(names, sprites, 50, 35, solid)).toBe("a.js");
  expect(pickAt([], sprites, 50, 35, solid)).toBe("d.js");
});

test("the front-most opaque pixel wins, and a see-through pixel falls to what is behind", () => {
  const sprites: Placement<string>[] = [
    { thing: "back", box: { x: 0, y: 0, w: 10, h: 10 }, cols: 10, rows: 10 },
    { thing: "front", box: { x: 0, y: 0, w: 10, h: 10 }, cols: 10, rows: 10 },
  ];
  expect(pickAt([], sprites, 5, 5, solid)).toBe("front");
  expect(pickAt([], sprites, 5, 5, (thing) => thing === "back")).toBe("back");
  expect(pickAt([], sprites, 50, 5, solid)).toBeUndefined();
});

test("picking inverts the rounded box that was drawn, not the unrounded zoom", () => {
  // A 288-pixel sprite at zoom 0.73 is drawn 210 pixels wide (210.24 rounded) from x = 17.
  const sprite: Placement<string> = { thing: "a.js", box: { x: 17, y: 4, w: 210, h: 195 }, cols: 288, rows: 267 };
  const seen: [number, number][] = [];
  pickAt([], [sprite], 17 + 105, 4 + 97.5, (_thing, column, row) => (seen.push([column, row]), true));
  expect(seen).toEqual([[144, 133]]);
  // The last drawn pixel column is inside; the one after is outside.
  expect(pickAt([], [sprite], 17 + 209.9, 10, solid)).toBe("a.js");
  expect(pickAt([], [sprite], 17 + 210, 10, solid)).toBeUndefined();
});
