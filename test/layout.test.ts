import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { isCodeNode, lineCount } from "../src/graph.ts";
import type { Graph, ModuleNode, NodeId } from "../src/graph.ts";
import { GENERATED_WEIGHT, layout } from "../src/layout.ts";
import type { Rect } from "../src/layout.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const EPSILON = 1e-9;

function syntheticTree(): Map<string, string> {
  const tree = new Map<string, string>([["package.json", "{}\n"]]);
  for (let i = 0; i < 40; i++) {
    const dir = ["src", "src/deep/er", "lib", "pkg"][i % 4];
    tree.set(`${dir}/file${i}.ts`, "const f = () => 1;\n".repeat((i * 37) % 23));
  }
  tree.set("pkg/package.json", "{}");
  return tree;
}

const graphs: [string, Graph][] = [
  ["the small fixture", extract(readFixtureTree(fileURLToPath(new URL("fixtures/small", import.meta.url))))],
  ["a synthetic tree", extract(syntheticTree())],
];

function fileWeight(graph: Graph, node: ModuleNode): number {
  if (node.level === "file") {
    return node.generated ? Math.min(Math.max(node.lines, 1), GENERATED_WEIGHT) : Math.max(node.lines, 1);
  }
  return graph.nodes
    .filter((child) => child.parent === node.id)
    .reduce((sum, child) => sum + fileWeight(graph, child), 0);
}

const area = (rect: Rect) => rect.w * rect.h;

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - EPSILON &&
    inner.y >= outer.y - EPSILON &&
    inner.x + inner.w <= outer.x + outer.w + EPSILON &&
    inner.y + inner.h <= outer.y + outer.h + EPSILON
  );
}

describe.each(graphs)("layout of %s", (_, graph) => {
  const width = 1200;
  const height = 800;
  const rects = layout(graph, width, height);
  const drawn = graph.nodes.filter((node) => !isCodeNode(node));
  const rectOf = new Map<NodeId, Rect>(rects.map((rect) => [rect.id, rect]));
  const viewport: Rect = { id: "viewport" as NodeId, x: 0, y: 0, w: width, h: height, depth: -1 };

  test("gives every package, folder and file exactly one rect, the root filling the viewport", () => {
    expect(rects.map((rect) => rect.id).sort()).toEqual(drawn.map((node) => node.id).sort());
    const root = graph.nodes.find((node) => node.parent === null);
    expect(root && rectOf.get(root.id)).toMatchObject({ x: 0, y: 0, w: width, h: height, depth: 0 });
  });

  test("keeps every rect inside the viewport and inside its parent, one level deeper", () => {
    for (const node of drawn) {
      const rect = rectOf.get(node.id)!;
      expect(contains(viewport, rect), node.id).toBe(true);
      if (node.parent === null) continue;
      const parent = rectOf.get(node.parent)!;
      expect(contains(parent, rect), node.id).toBe(true);
      expect(rect.depth).toBe(parent.depth + 1);
    }
  });

  test("sizes siblings in proportion to their line counts, at least one line each", () => {
    for (const parent of drawn) {
      const siblings = drawn.filter((node) => node.parent === parent.id);
      if (siblings.length === 0) continue;
      const totalArea = siblings.reduce((sum, node) => sum + area(rectOf.get(node.id)!), 0);
      const totalWeight = siblings.reduce((sum, node) => sum + fileWeight(graph, node), 0);
      for (const node of siblings) {
        expect(area(rectOf.get(node.id)!) / totalArea).toBeCloseTo(fileWeight(graph, node) / totalWeight, 9);
        expect(area(rectOf.get(node.id)!)).toBeGreaterThan(0);
      }
    }
  });

  test("never overlaps siblings", () => {
    for (const parent of graph.nodes) {
      const siblings = rects.filter((rect) => graph.nodes.find((n) => n.id === rect.id)?.parent === parent.id);
      for (const a of siblings) {
        for (const b of siblings) {
          if (a === b) continue;
          const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          expect(overlapW <= EPSILON || overlapH <= EPSILON, `${a.id} and ${b.id}`).toBe(true);
        }
      }
    }
  });

  test("is the same with or without classes and functions in the graph", () => {
    expect(drawn.length).toBeLessThan(graph.nodes.length);
    expect(layout({ ...graph, nodes: drawn }, width, height)).toEqual(rects);
  });

  test("depends only on the graph and the viewport", () => {
    const reordered: Graph = { ...graph, nodes: [...graph.nodes].reverse() };
    expect(layout(reordered, width, height)).toEqual(rects);
    expect(layout(graph, width, height)).toEqual(rects);
  });
});

describe("layout of generated files", () => {
  const tree = new Map<string, string>([
    ["package.json", "{}\n"],
    ["package-lock.json", "x\n".repeat(5000)],
    ["yarn.lock", "x\n".repeat(3)],
    ["written.ts", "x\n".repeat(GENERATED_WEIGHT)],
  ]);
  const graph = extract(tree);
  const rects = layout(graph, 1200, 800);
  const areaOf = (path: string) => {
    const node = graph.nodes.find((n) => n.level === "file" && n.path === path)!;
    return area(rects.find((rect) => rect.id === node.id)!);
  };

  test("caps a long generated file at the weight of GENERATED_WEIGHT lines", () => {
    expect(areaOf("package-lock.json")).toBeCloseTo(areaOf("written.ts"), 6);
  });

  test("leaves a short generated file at its line count", () => {
    expect(areaOf("yarn.lock") / areaOf("written.ts")).toBeCloseTo(3 / GENERATED_WEIGHT, 9);
  });

  test("keeps the true line count in the graph", () => {
    expect(lineCount(graph.nodes.find((n) => n.path === "package-lock.json")!)).toBe(5000);
  });
});
