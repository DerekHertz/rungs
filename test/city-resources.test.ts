import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PLAN_DEPTH, PLAN_WIDTH, cityOf, reachMap, reachOf } from "../src/city.ts";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { rootOf } from "../src/graph.ts";
import type { NodeId } from "../src/graph.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const fixtureUrl = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const base = extract(readFixtureTree(fixtureUrl("small")));
const head = extract(readFixtureTree(fixtureUrl("small-head")));
const root = rootOf(head);
const bare = { ...head, edges: [] };

describe("resource slots", () => {
  const city = cityOf(pictureOf(head, null), root);

  test("one plate per kind some edge reaches, in the fixed order, in a row beyond the plan's far edge", () => {
    expect(city.resources.map((resource) => resource.kind)).toEqual(["process", "network", "file system", "timer"]);
    for (const resource of city.resources) expect(resource.y).toBeGreaterThan(PLAN_DEPTH);
    expect(new Set(city.resources.map((resource) => resource.y)).size).toBe(1);
    const xs = city.resources.map((resource) => resource.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    const last = city.resources.at(-1)!;
    expect(city.resources[0]!.x + (last.x + last.w - city.resources[0]!.x) / 2).toBeCloseTo(PLAN_WIDTH / 2);
  });

  test("code loaded at run time gets a plate after the others", () => {
    const loading = extract(new Map([["a.cjs", "const fs = require('fs');\nfunction f(n) { fs.readFileSync(n); return require(n); }"]]));
    const loadingCity = cityOf(pictureOf(loading, null), rootOf(loading));
    expect(loadingCity.resources.map((resource) => resource.kind)).toEqual(["file system", "code loaded at run time"]);
  });

  test("a graph without edges has no plates and no reaches", () => {
    const plain = cityOf(pictureOf(bare, null), root);
    expect(plain.resources).toEqual([]);
    for (const building of plain.buildings) expect(building.reach).toEqual({ kinds: [], fresh: [] });
  });

  test("only kinds that are present get a slot", () => {
    const network = { ...head, edges: head.edges.filter((edge) => edge.to === "resource:network") };
    expect(cityOf(pictureOf(network, null), root).resources.map((resource) => resource.kind)).toEqual(["network"]);
  });

  test("the treemap does not move: buildings and districts are byte-identical with and without edges", () => {
    const plain = cityOf(pictureOf(bare, null), root);
    const rects = (c: typeof city) =>
      JSON.stringify({ d: c.districts, b: c.buildings }, (key, value: unknown) => (key === "reach" ? undefined : value));
    expect(rects(city)).toBe(rects(plain));
  });

  test("a building reaches the resources of its own and its nested code, and each plate counts its files", () => {
    const building = city.buildings.find((b) => b.id === "file:src/effects.mjs")!;
    expect(building.reach.kinds).toEqual(["process", "network", "file system", "timer"]);
    expect(building.reach.fresh).toEqual([]);
    expect(city.buildings.find((b) => b.id === "file:src/shapes.ts")!.reach.kinds).toEqual([]);
    expect(city.resources.find((r) => r.kind === "timer")!.files).toBe(1);
  });
});

describe("resources under a comparison", () => {
  const picture = pictureOf(head, compare(base, head));
  const city = cityOf(picture, root);

  test("a building whose edges are new says which kinds, and plates count them", () => {
    const building = city.buildings.find((b) => b.id === "file:src/effects.mjs")!;
    expect(building.reach.fresh).toEqual(["process", "network"]);
    expect(city.resources.find((r) => r.kind === "process")!.fresh).toBe(1);
    expect(city.resources.find((r) => r.kind === "timer")!.fresh).toBe(0);
  });

  test("a function reaches its own edges and its closures', and only its own are new", () => {
    const reach = reachMap(picture);
    expect(reach.get('function:src/effects.mjs#serve' as NodeId)).toEqual({ kinds: ["network", "file system"], fresh: ["network"] });
    expect(reach.get('function:src/effects.mjs#build' as NodeId)).toEqual({ kinds: ["process"], fresh: [] });
  });

  test("a function with no effects reaches nothing, though its file reaches plenty", () => {
    const reaches = reachMap(picture);
    expect(reaches.has("function:src/effects.mjs#save" as NodeId)).toBe(false);
    expect(reachOf(reaches, "function:src/effects.mjs#save" as NodeId)).toEqual({ kinds: [], fresh: [] });
    expect(reachOf(reaches, "file:src/effects.mjs" as NodeId).kinds.length).toBeGreaterThan(0);
  });
});
