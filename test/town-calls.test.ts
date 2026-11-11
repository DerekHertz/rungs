import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { NodeId } from "../src/graph.ts";
import { reachMap } from "../src/reach.ts";
import { callsOut, clipToView, fileOfSelection, reachLines, stackTags } from "../src/town-calls.ts";
import { townOf } from "../src/town.ts";
import type { Pier } from "../src/town.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const fixture = (name: string) => extract(readFixtureTree(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url))));
const base = fixture("small");
const head = fixture("small-head");
const SHEET = new Set(["workshop-1", "workshop-2", "workshop-3", "lab-1", "lab-2", "library", "shed", "warehouse", "hut", "rubble", "sign-moved"]);
const id = (value: string) => value as NodeId;

describe("buildings that call out", () => {
  const comparison = compare(base, head);
  const picture = pictureOf(head, comparison);
  const reaches = reachMap(picture);
  const town = townOf(picture.graph, SHEET, comparison);

  test("a changed file with a new effect edge is marked", () => {
    const lot = town.lots.find((candidate) => candidate.path === "src/effects.mjs")!;
    expect(["altered", "added"]).toContain(lot.change);
    expect(callsOut(town.lots, reaches).has(lot.id)).toBe(true);
  });

  test("an unchanged file is never marked, though it reaches outside", () => {
    const plain = townOf(head, SHEET);
    const plainReach = reachMap(pictureOf(head, null));
    expect(plainReach.get(id("file:src/effects.mjs"))!.kinds.length).toBeGreaterThan(0);
    expect(callsOut(plain.lots, plainReach).size).toBe(0);
  });

  test("a changed file whose edges are all old is not marked", () => {
    const old = new Map([[id("file:src/shapes.ts"), { kinds: ["network" as const], fresh: [] }]]);
    expect(callsOut([{ id: id("file:src/shapes.ts"), change: "altered" }], old).size).toBe(0);
  });

  test("only an altered or added lot is marked", () => {
    const fresh = new Map([[id("file:a"), { kinds: ["network" as const], fresh: ["network" as const] }]]);
    for (const change of ["removed", "moved-away", "moved", "unchanged"] as const) expect(callsOut([{ id: id("file:a"), change }], fresh).size).toBe(0);
    for (const change of ["altered", "added"] as const) expect(callsOut([{ id: id("file:a"), change }], fresh).size).toBe(1);
  });
});

describe("lines to the harbour", () => {
  const piers: Pier[] = [
    { kind: "process", sprite: "port-process", X: 20, Y: -4 },
    { kind: "network", sprite: "port-network", X: 20, Y: 0 },
    { kind: "timer", sprite: "port-timer", X: 20, Y: 4 },
  ];

  test("one line per reached kind that has a structure, in harbour order", () => {
    const lines = reachLines({ kinds: ["timer", "network", "queue"], fresh: ["network"] }, piers, true);
    expect(lines.map((line) => line.kind)).toEqual(["network", "timer"]);
    expect(lines.map((line) => line.fresh)).toEqual([true, false]);
  });

  test("with no comparison every line is bright", () => {
    expect(reachLines({ kinds: ["network"], fresh: [] }, piers, false).map((line) => line.fresh)).toEqual([true]);
  });

  test("nothing reached, nothing drawn", () => {
    expect(reachLines(undefined, piers, true)).toEqual([]);
  });
});

describe("keeping a line on the screen", () => {
  const view = { width: 1000, height: 600 };

  test("a line wholly inside is kept as it is", () => {
    expect(clipToView({ x: 100, y: 100 }, { x: 800, y: 500 }, view, 10)).toEqual({ from: { x: 100, y: 100 }, to: { x: 800, y: 500 }, cut: false });
  });

  test("a harbour end far off the screen is cut at the edge and says so", () => {
    const clipped = clipToView({ x: 500, y: 300 }, { x: 5000, y: 300 }, view, 10)!;
    expect(clipped.to).toEqual({ x: 990, y: 300 });
    expect(clipped.from).toEqual({ x: 500, y: 300 });
    expect(clipped.cut).toBe(true);
  });

  test("a line leaving upward is cut at the top inset", () => {
    const clipped = clipToView({ x: 500, y: 300 }, { x: 500, y: -4000 }, view, 10)!;
    expect(clipped.to).toEqual({ x: 500, y: 10 });
  });

  test("a line wholly off the screen is dropped", () => {
    expect(clipToView({ x: -500, y: 300 }, { x: -100, y: 900 }, view, 10)).toBeUndefined();
  });

  test("a building scrolled off still draws the part of the line that crosses the screen", () => {
    const clipped = clipToView({ x: -400, y: 300 }, { x: 600, y: 300 }, view, 10)!;
    expect(clipped.from).toEqual({ x: 10, y: 300 });
    expect(clipped.to).toEqual({ x: 600, y: 300 });
    expect(clipped.cut).toBe(false);
  });
});

describe("which building a selection stands for", () => {
  const lots = [{ id: id("file:src/effects.mjs") }, { id: id("file:src/a#b.ts") }];

  test("a file is its own building", () => {
    expect(fileOfSelection(id("file:src/effects.mjs"), lots)).toBe(id("file:src/effects.mjs"));
  });

  test("a function or class stands for the file it is in", () => {
    expect(fileOfSelection(id("function:src/effects.mjs#serve"), lots)).toBe(id("file:src/effects.mjs"));
    expect(fileOfSelection(id("class:src/effects.mjs#Server"), lots)).toBe(id("file:src/effects.mjs"));
    expect(fileOfSelection(id("function:src/effects.mjs#Server.start"), lots)).toBe(id("file:src/effects.mjs"));
  });

  test("a selection in no building stands for none", () => {
    expect(fileOfSelection(id("function:src/none.mjs#f"), lots)).toBeUndefined();
  });
});

describe("tags of lines cut at the edge", () => {
  const view = { width: 600, height: 600 };
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  test("tags that would overlap are stacked apart, each kept inside the view", () => {
    const placed = stackTags(
      [
        { text: "process \u2192", x: 456, y: 572, w: 90, h: 20 },
        { text: "network \u2192", x: 507, y: 572, w: 90, h: 20 },
        { text: "file system \u2192", x: 566, y: 572, w: 120, h: 20 },
      ],
      view,
    );
    for (const [i, a] of placed.entries()) {
      expect(a.x - a.w / 2).toBeGreaterThanOrEqual(0);
      expect(a.x + a.w / 2).toBeLessThanOrEqual(600);
      expect(a.y - a.h / 2).toBeGreaterThanOrEqual(0);
      expect(a.y + a.h / 2).toBeLessThanOrEqual(600);
      for (const b of placed.slice(i + 1)) expect(overlap({ ...a, x: a.x - a.w / 2, y: a.y - a.h / 2 }, { ...b, x: b.x - b.w / 2, y: b.y - b.h / 2 })).toBe(false);
    }
  });

  test("a tag that overlaps nothing stays where it is, and each keeps its line's end", () => {
    const placed = stackTags([{ text: "timer \u2192", x: 300, y: 300, w: 80, h: 20 }], view);
    expect([placed[0]!.x, placed[0]!.y]).toEqual([300, 300]);
    const two = stackTags([{ text: "a", x: 500, y: 580, w: 80, h: 20 }, { text: "b", x: 520, y: 580, w: 80, h: 20 }], view);
    expect(two.map((tag) => [tag.endX, tag.endY])).toEqual([[500, 580], [520, 580]]);
  });
});
