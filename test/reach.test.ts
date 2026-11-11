import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { NodeId } from "../src/graph.ts";
import { reachMap } from "../src/reach.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const fixtureUrl = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const base = extract(readFixtureTree(fixtureUrl("small")));
const head = extract(readFixtureTree(fixtureUrl("small-head")));
const id = (value: string) => value as NodeId;

describe("reach", () => {
  const reach = reachMap(pictureOf(head, null));

  test("a file reaches the resources of its own and its nested code, in the fixed order", () => {
    expect(reach.get(id("file:src/effects.mjs"))).toEqual({ kinds: ["process", "network", "file system", "timer"], fresh: [] });
    expect(reach.has(id("file:src/shapes.ts"))).toBe(false);
  });

  test("a graph without edges reaches nothing", () => {
    expect(reachMap(pictureOf({ ...head, edges: [] }, null)).size).toBe(0);
  });
});

describe("reach under a comparison", () => {
  const reach = reachMap(pictureOf(head, compare(base, head)));

  test("a file whose edges are new says which kinds", () => {
    expect(reach.get(id("file:src/effects.mjs"))!.fresh).toEqual(["process", "network"]);
  });

  test("a function reaches its own edges and its closures', and only its own are new", () => {
    expect(reach.get(id("function:src/effects.mjs#serve"))).toEqual({ kinds: ["network", "file system"], fresh: ["network"] });
    expect(reach.get(id("function:src/effects.mjs#build"))).toEqual({ kinds: ["process"], fresh: [] });
  });

  test("a function with no effects reaches nothing, though its file reaches plenty", () => {
    expect(reach.has(id("function:src/effects.mjs#save"))).toBe(false);
    expect(reach.get(id("file:src/effects.mjs"))!.kinds.length).toBeGreaterThan(0);
  });
});
