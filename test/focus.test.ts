import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { cityOf, MAX_HEIGHT, PLATE_HEIGHT } from "../src/city.ts";
import { flyTarget, namedDistricts, regionTop } from "../src/focus.ts";
import { extract } from "../src/extract/extract.ts";
import type { NodeId } from "../src/graph.ts";
import { indexGraph } from "../src/zoom.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const graph = extract(readFixtureTree(fileURLToPath(new URL("fixtures/small", import.meta.url))));
const tree = indexGraph(graph);
const city = cityOf(graph, tree.root);
const id = (value: string) => value as NodeId;
const named = (focus: NodeId): [string, number][] =>
  namedDistricts(city.districts, focus)
    .map(({ district, below }): [string, number] => [district.id, below])
    .sort();

describe("namedDistricts", () => {
  test("names the districts one and two levels below the focus, and no deeper", () => {
    expect(named(tree.root)).toEqual([
      ["folder:docs", 1],
      ["folder:packages", 1],
      ["folder:src", 1],
      ["folder:src/util", 2],
      ["folder:test", 1],
      ["package:packages/widget", 2],
    ]);
  });

  test("moves down with the focus", () => {
    expect(named(id("folder:packages"))).toEqual([
      ["folder:packages/widget/assets", 2],
      ["folder:packages/widget/src", 2],
      ["package:packages/widget", 1],
    ]);
    expect(named(id("folder:src"))).toEqual([["folder:src/util", 1]]);
  });

  test("names nothing under a district with no district inside, or under something that is not a district", () => {
    expect(named(id("folder:src/util"))).toEqual([]);
    expect(named(id("file:src/shapes.ts"))).toEqual([]);
  });

  test("never names the focus itself", () => {
    for (const district of city.districts) {
      expect(namedDistricts(city.districts, district.id).map((entry) => entry.district.id)).not.toContain(district.id);
    }
  });
});

describe("flyTarget", () => {
  const from = (focus: string, hit: string): string => flyTarget(tree, id(focus), id(hit));

  test("flies to the district hit when it is one of the named levels below the focus", () => {
    expect(from(tree.root, "folder:src")).toBe("folder:src");
    expect(from(tree.root, "folder:src/util")).toBe("folder:src/util");
  });

  test("stops at the deepest named level when the hit is deeper", () => {
    expect(from(tree.root, "folder:packages/widget/assets")).toBe("package:packages/widget");
    expect(from("folder:packages", "folder:packages/widget/assets")).toBe("folder:packages/widget/assets");
  });

  test("stays put on the focus itself", () => {
    expect(from("folder:src", "folder:src")).toBe("folder:src");
    expect(from(tree.root, tree.root)).toBe(tree.root);
  });

  test("flies out to a district around the focus", () => {
    expect(from("folder:src/util", "folder:src")).toBe("folder:src");
    expect(from("folder:src/util", tree.root)).toBe(tree.root);
  });

  test("counts from the top of the repository for a district outside the focus", () => {
    expect(from("folder:src", "folder:packages/widget/src")).toBe("package:packages/widget");
    expect(from("folder:src", "folder:docs")).toBe("folder:docs");
  });
});

describe("regionTop", () => {
  const top = (path: string) => regionTop(city, city.districts.find((district) => district.id === `folder:${path}`)!);

  test("is the roof of the tallest building in the district", () => {
    expect(top("src")).toBeCloseTo(2 * PLATE_HEIGHT + MAX_HEIGHT, 9);
  });

  test("never falls below the district's own plate", () => {
    for (const district of city.districts) expect(regionTop(city, district)).toBeGreaterThanOrEqual(district.base + PLATE_HEIGHT);
  });

  test("is the whole city's top for the root", () => {
    expect(regionTop(city, city.districts.find((district) => district.level === 0)!)).toBeCloseTo(city.top, 9);
  });

  test("is no higher for a district than for the one it stands on", () => {
    expect(top("src/util")).toBeLessThanOrEqual(top("src"));
  });
});
