import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildCity, cityOf, heightScale, MAX_HEIGHT, MIN_HEIGHT, PLAN_DEPTH, PLAN_WIDTH, PLATE_HEIGHT } from "../src/city.ts";
import type { Building, District } from "../src/city.ts";
import { extract } from "../src/extract/extract.ts";
import { isCodeNode, rootOf } from "../src/graph.ts";
import type { Graph, ModuleNode, NodeId, Role } from "../src/graph.ts";
import { layout, leafWeight } from "../src/layout.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const EPSILON = 1e-9;

function syntheticTree(): Map<string, string> {
  const tree = new Map<string, string>([["package.json", "{}\n"]]);
  for (let i = 0; i < 40; i++) {
    const dir = ["src", "src/deep/er", "lib", "pkg"][i % 4];
    tree.set(`${dir}/file${i}.ts`, "function f() {}\n".repeat((i * 37) % 23));
  }
  tree.set("pkg/package.json", "{}");
  return tree;
}

const fixture = extract(readFixtureTree(fileURLToPath(new URL("fixtures/small", import.meta.url))));
const graphs: [string, Graph][] = [
  ["the small fixture", fixture],
  ["a synthetic tree", extract(syntheticTree())],
];

function nodeOf(graph: Graph, id: string): ModuleNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
}

function codeIn(graph: Graph, path: string, level: "class" | "function"): number {
  return graph.nodes.filter((node) => isCodeNode(node) && node.path === path && node.level === level).length;
}

describe("heightScale", () => {
  const counts = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
  const scale = heightScale(counts);

  test("puts the repository's fewest at the minimum and its most at the maximum", () => {
    expect(scale.fewest).toBe(0);
    expect(scale.most).toBe(89);
    expect(scale.height(0)).toBe(MIN_HEIGHT);
    expect(scale.height(89)).toBeCloseTo(MAX_HEIGHT, 9);
  });

  test("follows the square root between them", () => {
    expect(scale.height(22.25)).toBeCloseTo(MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * Math.sqrt(0.25), 9);
  });

  test("never lowers a building that has more", () => {
    for (let count = 1; count <= 89; count++) {
      expect(scale.height(count)).toBeGreaterThanOrEqual(scale.height(count - 1));
    }
  });

  test("keeps a visible minimum above the plate it stands on", () => {
    expect(MIN_HEIGHT).toBeGreaterThan(PLATE_HEIGHT);
    expect(scale.height(scale.fewest)).toBeGreaterThan(PLATE_HEIGHT);
  });

  test("does not let one outlier flatten the median", () => {
    const withOutlier = heightScale([...Array.from({ length: 20 }, (_, i) => i + 1), 1000]);
    const range = MAX_HEIGHT - MIN_HEIGHT;
    const linear = (10 - 1) / (1000 - 1);
    expect((withOutlier.height(10) - MIN_HEIGHT) / range).toBeGreaterThan(4 * linear);
    expect((withOutlier.height(10) - MIN_HEIGHT) / range).toBeCloseTo(Math.sqrt(linear), 9);
  });

  test("draws every building at the minimum when all files have the same count", () => {
    for (const same of [[3, 3, 3], [0, 0], [7]]) {
      const flat = heightScale(same);
      expect(flat.height(same[0]!)).toBe(MIN_HEIGHT);
    }
  });

  test("copes with a repository that has no files", () => {
    expect(heightScale([]).height(0)).toBe(MIN_HEIGHT);
  });

  test("stays between the minimum and the maximum for a count outside the repository's", () => {
    expect(scale.height(-5)).toBe(MIN_HEIGHT);
    expect(scale.height(10_000)).toBeCloseTo(MAX_HEIGHT, 9);
  });
});

describe.each(graphs)("the city of %s", (_, graph) => {
  const root = rootOf(graph);
  const city = cityOf(graph, root);
  const districts = new Map<NodeId, District>(city.districts.map((district) => [district.id, district]));
  const buildings = new Map<NodeId, Building>(city.buildings.map((building) => [building.id, building]));
  const files = graph.nodes.filter((node) => node.level === "file");
  const rects = layout(graph, root, PLAN_WIDTH, PLAN_DEPTH);
  const lotOf = new Map(rects.map((rect) => [rect.id, rect]));

  test("is laid out at a fixed logical size", () => {
    expect(city.width).toBe(PLAN_WIDTH);
    expect(city.depth).toBe(PLAN_DEPTH);
    expect(districts.get(root)).toMatchObject({ x: 0, y: 0, w: PLAN_WIDTH, d: PLAN_DEPTH, level: 0 });
  });

  test("gives every file a building and every package and folder a district, and nothing else", () => {
    expect([...buildings.keys()].sort()).toEqual(files.map((file) => file.id).sort());
    const containers = graph.nodes.filter((node) => node.level === "package" || node.level === "folder");
    expect([...districts.keys()].sort()).toEqual(containers.map((container) => container.id).sort());
  });

  test("draws no class or function", () => {
    for (const id of [...buildings.keys(), ...districts.keys()]) expect(isCodeNode(nodeOf(graph, id)), id).toBe(false);
  });

  test("never moves a lot: a building stands inside its file's rect, inset by five percent of the shorter side", () => {
    for (const building of city.buildings) {
      const lot = lotOf.get(building.id)!;
      const inset = 0.05 * Math.min(lot.w, lot.h);
      expect(building.x).toBeCloseTo(lot.x + inset, 9);
      expect(building.y).toBeCloseTo(lot.y + inset, 9);
      expect(building.w).toBeCloseTo(lot.w - 2 * inset, 9);
      expect(building.d).toBeCloseTo(lot.h - 2 * inset, 9);
    }
  });

  test("keeps a district exactly on its rect and nests each one inside its parent, one level up", () => {
    for (const district of city.districts) {
      const lot = lotOf.get(district.id)!;
      expect([district.x, district.y, district.w, district.d]).toEqual([lot.x, lot.y, lot.w, lot.h]);
      const parentId = nodeOf(graph, district.id).parent;
      if (parentId === null) {
        expect(district.level).toBe(0);
        continue;
      }
      const parent = districts.get(parentId)!;
      expect(district.level).toBe(parent.level + 1);
      expect(district.base).toBe(district.level * PLATE_HEIGHT);
      expect(district.x).toBeGreaterThanOrEqual(parent.x - EPSILON);
      expect(district.y).toBeGreaterThanOrEqual(parent.y - EPSILON);
      expect(district.x + district.w).toBeLessThanOrEqual(parent.x + parent.w + EPSILON);
      expect(district.y + district.d).toBeLessThanOrEqual(parent.y + parent.d + EPSILON);
    }
  });

  test("stands each building on the top of its district, inside it", () => {
    for (const building of city.buildings) {
      const district = districts.get(nodeOf(graph, building.id).parent!)!;
      expect(building.base).toBe(district.base + PLATE_HEIGHT);
      expect(building.x).toBeGreaterThanOrEqual(district.x - EPSILON);
      expect(building.y).toBeGreaterThanOrEqual(district.y - EPSILON);
      expect(building.x + building.w).toBeLessThanOrEqual(district.x + district.w + EPSILON);
      expect(building.y + building.d).toBeLessThanOrEqual(district.y + district.d + EPSILON);
    }
  });

  test("counts every class and function written in the file, nested ones included", () => {
    for (const building of city.buildings) {
      const path = nodeOf(graph, building.id).path;
      expect(building.classes, path).toBe(codeIn(graph, path, "class"));
      expect(building.functions, path).toBe(codeIn(graph, path, "function"));
    }
  });

  test("sizes each building by the scale over the repository's files", () => {
    const counts = city.buildings.map((building) => building.classes + building.functions);
    expect(city.counts).toEqual({ fewest: Math.min(...counts), most: Math.max(...counts) });
    const scale = heightScale(counts);
    for (const building of city.buildings) {
      expect(building.height).toBe(scale.height(building.classes + building.functions));
      expect(building.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
      expect(building.height).toBeLessThanOrEqual(MAX_HEIGHT + EPSILON);
    }
    expect(city.top).toBe(Math.max(...city.buildings.map((building) => building.base + building.height)));
  });

  test("colours a building by its file's role", () => {
    for (const building of city.buildings) {
      const file = nodeOf(graph, building.id);
      expect(building.role).toBe(file.level === "file" ? file.role : undefined);
    }
  });

  test("colours a district by the role covering the most lines under it, generated files capped as the layout draws them", () => {
    for (const district of city.districts) {
      const below = city.buildings.filter((building) => isBelow(graph, building.id, district.id));
      const lines = new Map<Role | null, number>();
      for (const building of below) lines.set(building.role, (lines.get(building.role) ?? 0) + leafWeight(nodeOf(graph, building.id)));
      const best = Math.max(0, ...lines.values());
      const tied = [...lines].filter(([, value]) => value === best).map(([role]) => role);
      expect(tied, district.id).toContain(district.role);
    }
  });

  test("depends only on the graph and the root", () => {
    const reordered: Graph = { ...graph, nodes: [...graph.nodes].reverse() };
    expect(cityOf(reordered, root)).toEqual(city);
    expect(cityOf(graph, root)).toEqual(city);
    expect(buildCity(graph, rects)).toEqual(city);
  });
});

describe("the small fixture's city", () => {
  const city = cityOf(fixture, rootOf(fixture));
  const building = (path: string): Building => city.buildings.find((candidate) => candidate.id === `file:${path}`)!;
  const district = (path: string): District => city.districts.find((candidate) => candidate.id === `folder:${path}`)!;

  test("makes the file with the most classes and functions the tallest", () => {
    const tallest = city.buildings.reduce((a, b) => (b.height > a.height ? b : a));
    expect(tallest.id).toBe("file:src/shapes.ts");
    expect(tallest.height).toBeCloseTo(MAX_HEIGHT, 9);
  });

  test("leaves a file with none, and a file no adapter read, as the minimum slab", () => {
    expect(building("src/util/empty.ts").height).toBe(MIN_HEIGHT);
    expect(building("README.md").height).toBe(MIN_HEIGHT);
    expect(building("README.md").role).toBe("docs");
  });

  test("marks a file no language adapter read as not analysed", () => {
    expect(building("README.md").analysed).toBe(false);
    expect(building("src/util/empty.ts").analysed).toBe(true);
  });

  test("leaves a file the role table does not recognise without a role", () => {
    expect(building("packages/widget/assets/theme.json").role).toBeNull();
  });

  test("tints a district by its dominant role", () => {
    expect(district("src").role).toBe("source");
    expect(district("docs").role).toBe("docs");
    expect(district("test").role).toBe("tests");
    expect(district("packages/widget/assets").role).toBeNull();
  });

  test("stacks a nested district on its parent", () => {
    expect(district("src/util").level).toBe(district("src").level + 1);
  });
});

function isBelow(graph: Graph, id: NodeId, ancestor: NodeId): boolean {
  for (let current: NodeId | null = nodeOf(graph, id).parent; current !== null; current = nodeOf(graph, current).parent) {
    if (current === ancestor) return true;
  }
  return false;
}
