import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { BAND_MIN, changedBand, cityOf } from "../src/city.ts";
import type { Building, District } from "../src/city.ts";
import { compare, pictureOf, tallyText } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { rootOf } from "../src/graph.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const fixtureUrl = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const base = extract(readFixtureTree(fixtureUrl("small")));
const head = extract(readFixtureTree(fixtureUrl("small-head")));
const root = rootOf(head);

describe("a city that is not comparing", () => {
  const city = cityOf(pictureOf(head, null), root);
  test("has no change, tally or ghost anywhere", () => {
    expect(city.compared).toBe(false);
    for (const building of city.buildings) {
      expect(building.change).toBeNull();
      expect(building.tally).toBeNull();
    }
    for (const district of city.districts) {
      expect(district.ghost).toBe(false);
      expect(district.tally).toBeNull();
    }
  });
});

describe("a city that is comparing", () => {
  const picture = pictureOf(head, compare(base, head));
  const city = cityOf(picture, root);
  const building = (path: string): Building => city.buildings.find((b) => b.id === `file:${path}`)!;
  const district = (id: string): District => city.districts.find((d) => d.id === id)!;

  test("marks every building with its change", () => {
    expect(city.compared).toBe(true);
    expect(building("src/shapes.ts").change).toBe("altered");
    expect(building("src/main.ts").change).toBe("added");
    expect(building("src/compat/legacy.js").change).toBe("moved");
    expect(building("src/index.ts").change).toBe("removed");
    expect(building("README.md").change).toBe("unchanged");
  });

  test("draws a removed file as a building and a removed folder as a ghost district around it", () => {
    expect(district("folder:test").ghost).toBe(true);
    expect(district("folder:src").ghost).toBe(false);
    const ghost = building("test/helpers.ts");
    const plot = district("folder:test");
    expect(ghost.x).toBeGreaterThanOrEqual(plot.x);
    expect(ghost.x + ghost.w).toBeLessThanOrEqual(plot.x + plot.w);
    expect(ghost.y).toBeGreaterThanOrEqual(plot.y);
    expect(ghost.y + ghost.d).toBeLessThanOrEqual(plot.y + plot.d);
  });

  test("gives districts the tally of the files below and buildings the tally of their code", () => {
    expect(district(root).tally).toEqual({ added: 7, altered: 3, removed: 3, moved: 1 });
    expect(district("folder:test").tally).toEqual({ added: 0, altered: 0, removed: 1, moved: 0 });
    expect(building("src/util/math.ts").tally).toEqual({ added: 1, altered: 1, removed: 0, moved: 0 });
    expect(building("README.md").tally).toEqual({ added: 0, altered: 0, removed: 0, moved: 0 });
  });

  test("keeps colour as role, ghosts included", () => {
    expect(building("test/helpers.ts").role).toBe("tests");
    expect(building("src/index.ts").role).toBe("source");
  });

  test("places every building inside the plan without overlap with a sibling district", () => {
    for (const b of city.buildings) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(city.width + 1e-6);
      expect(b.y + b.d).toBeLessThanOrEqual(city.depth + 1e-6);
    }
  });
});

describe("tallyText", () => {
  test("lists only the kinds with files, added, altered, removed, moved", () => {
    expect(tallyText({ added: 3, altered: 5, removed: 1, moved: 2 })).toBe("+3 ~5 −1 →2");
    expect(tallyText({ added: 0, altered: 2, removed: 0, moved: 0 })).toBe("~2");
    expect(tallyText({ added: 0, altered: 0, removed: 0, moved: 0 })).toBe("");
  });
});

describe("changedBand", () => {
  const none = { added: 0, altered: 0, removed: 0, moved: 0 };

  test("is the share of a file's floors that are changed code, at least the visible minimum", () => {
    expect(changedBand(100, 10, { ...none, altered: 2, added: 3 })).toBe(50);
    expect(changedBand(100, 40, { ...none, altered: 1 })).toBe(BAND_MIN);
  });

  test("is the whole building when every floor changed", () => {
    expect(changedBand(40, 4, { ...none, altered: 4 })).toBe(40);
  });

  test("is 0 for a file with no functions or classes, whatever changed in it", () => {
    expect(changedBand(5, 0, { ...none })).toBe(0);
    expect(changedBand(5, 0, { ...none, altered: 1 })).toBe(0);
  });

  test("is 0 when no function or class changed: a comment or a removal lights no floor", () => {
    expect(changedBand(100, 9, { ...none })).toBe(0);
    expect(changedBand(100, 9, { ...none, removed: 4 })).toBe(0);
    expect(changedBand(100, 9, { ...none, moved: 2 })).toBe(0);
  });

  test("never taller than the building", () => {
    expect(changedBand(BAND_MIN - 1, 9, { ...none, altered: 1 })).toBe(BAND_MIN - 1);
  });
});

describe("a building's band in the city", () => {
  const city = cityOf(pictureOf(head, compare(base, head)), root);
  const building = (path: string): Building => city.buildings.find((b) => b.id === `file:${path}`)!;

  test("only an altered file has one, and it is part of its height", () => {
    const altered = building("src/util/math.ts");
    expect(altered.band).toBeGreaterThan(0);
    expect(altered.band!).toBeLessThanOrEqual(altered.height);
    for (const path of ["README.md", "src/main.ts", "src/compat/legacy.js", "src/index.ts"]) expect(building(path).band, path).toBeUndefined();
  });
});

describe("a comment-only change", () => {
  const tree = (text: string) => extract(new Map([["package.json", "{}\n"], ["src/a.ts", text], ["src/b.ts", "export function other() {}\nexport function more() {}\n"]]));
  const city = cityOf(pictureOf(tree("// new note\nexport function f() {}\n"), compare(tree("export function f() {}\n"), tree("// new note\nexport function f() {}\n"))), rootOf(tree("")));

  test("is an altered building with a band of 0, so no floor is lit", () => {
    const a = city.buildings.find((b) => b.id === "file:src/a.ts")!;
    expect(a.change).toBe("altered");
    expect(a.band).toBe(0);
  });
});

describe("what lights in an altered file", () => {
  const trees = (files: [string, string, string][]) => {
    const make = (side: 1 | 2) => extract(new Map([["package.json", "{}\n"], ...files.map(([path, before, after]): [string, string] => [path, side === 1 ? before : after])]));
    return cityOf(pictureOf(make(2), compare(make(1), make(2))), rootOf(make(2)));
  };
  const city = trees([
    ["src/code.ts", "// old\nexport function f() {}\n", "// new\nexport function f() {}\n"],
    ["README.md", "old\n", "new\n"],
    ["config.json", "{\"a\":1}\n", "{\"a\":2}\n"],
  ]);
  const band = (path: string) => city.buildings.find((b) => b.id === `file:${path}`)!;

  test("a code file with no changed function lights only its roof edge", () => {
    expect(band("src/code.ts").band).toBe(0);
  });

  test("a docs or config file, or one with no adapter, lights fully", () => {
    for (const path of ["README.md", "config.json"]) expect(band(path).band, path).toBe(band(path).height);
  });
});
