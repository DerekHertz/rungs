import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { isCodeNode, lineCount, rootOf } from "../src/graph.ts";
import type { Graph, ModuleNode, NodeId } from "../src/graph.ts";
import { GENERATED_WEIGHT, INSET, LABEL_BAND, layout, ownLines, reservesLabelBand } from "../src/layout.ts";
import type { Rect } from "../src/layout.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const EPSILON = 1e-9;
const WIDTH = 1200;
const HEIGHT = 800;

function syntheticTree(): Map<string, string> {
  const tree = new Map<string, string>([["package.json", "{}\n"]]);
  for (let i = 0; i < 40; i++) {
    const dir = ["src", "src/deep/er", "lib", "pkg"][i % 4];
    tree.set(`${dir}/file${i}.ts`, "const f = () => 1;\n".repeat((i * 37) % 23));
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

function weight(graph: Graph, node: ModuleNode): number {
  if (node.level === "file") {
    return node.role === "generated" ? Math.min(Math.max(node.lines, 1), GENERATED_WEIGHT) : Math.max(node.lines, 1);
  }
  if (isCodeNode(node)) return lineCount(node);
  return graph.nodes
    .filter((child) => child.parent === node.id && !isCodeNode(child))
    .reduce((sum, child) => sum + weight(graph, child), 0);
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

function overlaps(a: Rect, b: Rect): boolean {
  const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapW > EPSILON && overlapH > EPSILON;
}

function withoutCode(graph: Graph): Graph {
  return { ...graph, nodes: graph.nodes.filter((node) => !isCodeNode(node)) };
}

describe.each(graphs)("layout of %s rooted at the whole repository", (_, graph) => {
  const root = rootOf(graph);
  const rects = layout(graph, root, WIDTH, HEIGHT);
  const rectOf = new Map<NodeId, Rect>(rects.map((rect) => [rect.id, rect]));
  const viewport: Rect = { id: "viewport" as NodeId, x: 0, y: 0, w: WIDTH, h: HEIGHT, depth: -1 };
  const drawn = graph.nodes.filter((node) => !isCodeNode(node));

  test("gives every package, folder and file exactly one rect, the root filling the viewport", () => {
    const drawnIds = rects.filter((rect) => !isCodeNode(nodeOf(graph, rect.id))).map((rect) => rect.id);
    expect(drawnIds.sort()).toEqual(drawn.map((node) => node.id).sort());
    expect(rectOf.get(root)).toMatchObject({ x: 0, y: 0, w: WIDTH, h: HEIGHT, depth: 0 });
  });

  test("gives a class or function a rect exactly when its parent's rect reserves a label band", () => {
    for (const node of graph.nodes.filter(isCodeNode)) {
      const parent = rectOf.get(node.parent!);
      expect(rectOf.has(node.id), node.id).toBe(parent !== undefined && reservesLabelBand(parent));
    }
  });

  test("keeps every rect inside the viewport and inside its parent, one level deeper", () => {
    for (const rect of rects) {
      const node = nodeOf(graph, rect.id);
      expect(contains(viewport, rect), node.id).toBe(true);
      if (node.parent === null) continue;
      const parent = rectOf.get(node.parent)!;
      expect(contains(parent, rect), node.id).toBe(true);
      expect(rect.depth).toBe(parent.depth + 1);
    }
  });

  test("sizes siblings in proportion to their line counts, at least one line each", () => {
    for (const parent of rects) {
      const siblings = rects.filter((rect) => nodeOf(graph, rect.id).parent === parent.id);
      if (siblings.length === 0) continue;
      const totalArea = siblings.reduce((sum, rect) => sum + area(rect), 0);
      const totalWeight = siblings.reduce((sum, rect) => sum + weight(graph, nodeOf(graph, rect.id)), 0);
      for (const rect of siblings) {
        expect(area(rect) / totalArea, rect.id).toBeCloseTo(weight(graph, nodeOf(graph, rect.id)) / totalWeight, 9);
        expect(area(rect)).toBeGreaterThan(0);
      }
    }
  });

  test("never overlaps siblings", () => {
    for (const parent of rects) {
      const siblings = rects.filter((rect) => nodeOf(graph, rect.id).parent === parent.id);
      for (const a of siblings) {
        for (const b of siblings) {
          if (a !== b) expect(overlaps(a, b), `${a.id} and ${b.id}`).toBe(false);
        }
      }
    }
  });

  test("puts every package, folder and file where it would be if the graph had no classes or functions", () => {
    expect(drawn.length).toBeLessThan(graph.nodes.length);
    const before = layout(withoutCode(graph), root, WIDTH, HEIGHT);
    expect(rects.filter((rect) => !isCodeNode(nodeOf(graph, rect.id)))).toEqual(before);
  });

  test("depends only on the graph, the root and the viewport", () => {
    const reordered: Graph = { ...graph, nodes: [...graph.nodes].reverse() };
    expect(layout(reordered, root, WIDTH, HEIGHT)).toEqual(rects);
    expect(layout(graph, root, WIDTH, HEIGHT)).toEqual(rects);
  });
});

describe("layout rooted at a file", () => {
  const file = "file:src/shapes.ts" as NodeId;
  const rects = layout(fixture, file, WIDTH, HEIGHT);
  const rectOf = new Map<NodeId, Rect>(rects.map((rect) => [rect.id, rect]));
  const inFile = fixture.nodes.filter(isCodeNode).filter((node) => node.path === "src/shapes.ts");
  const topLevel = inFile.filter((node) => node.parent === file);

  test("fills the viewport with the file at depth 0 and draws nothing outside its subtree", () => {
    expect(rectOf.get(file)).toEqual({ id: file, x: 0, y: 0, w: WIDTH, h: HEIGHT, depth: 0 });
    for (const rect of rects) {
      const node = nodeOf(fixture, rect.id);
      expect(node.path, rect.id).toBe("src/shapes.ts");
    }
  });

  test("places the file's classes and functions with areas proportional to their line counts", () => {
    const placed = topLevel.map((node) => rectOf.get(node.id)!);
    expect(placed.every((rect) => rect !== undefined && rect.depth === 1)).toBe(true);
    const totalArea = placed.reduce((sum, rect) => sum + area(rect), 0);
    const totalLines = topLevel.reduce((sum, node) => sum + lineCount(node), 0);
    for (const node of topLevel) {
      expect(area(rectOf.get(node.id)!) / totalArea, node.id).toBeCloseTo(lineCount(node) / totalLines, 9);
    }
    expect(lineCount(nodeOf(fixture, "class:src/shapes.ts#Square"))).toBe(34);
    expect(lineCount(nodeOf(fixture, "class:src/shapes.ts#Circle"))).toBe(5);
  });

  test("leaves the lines no class or function covers as uncovered area, with no rect of its own", () => {
    const own = ownLines(
      { start: 1, end: lineCount(nodeOf(fixture, file)) },
      topLevel.map((node) => node.range),
    );
    const covered = topLevel.reduce((sum, node) => sum + lineCount(node), 0);
    const box = rectOf.get(file)!;
    const innerArea = (box.w - 2 * INSET) * (box.h - LABEL_BAND - INSET);
    const childArea = topLevel.reduce((sum, node) => sum + area(rectOf.get(node.id)!), 0);
    expect(own).toBeGreaterThan(0);
    expect(childArea / innerArea).toBeCloseTo(covered / (covered + own), 9);
    expect(childArea).toBeLessThan(innerArea);
    expect(rects.map((rect) => rect.id).sort()).toEqual(
      [file, ...inFile.filter((node) => rectOf.has(node.id)).map((node) => node.id)].sort(),
    );
  });

  test("nests a class's methods inside it, and a method's nested function inside that", () => {
    const square = rectOf.get("class:src/shapes.ts#Square" as NodeId)!;
    const area_ = rectOf.get("function:src/shapes.ts#Square.area" as NodeId)!;
    const squared = rectOf.get("function:src/shapes.ts#Square.area.squared" as NodeId);
    expect(contains(square, area_)).toBe(true);
    expect(area_.depth).toBe(2);
    expect(squared === undefined || (contains(area_, squared) && squared.depth === 3)).toBe(true);
  });

  test("gives the same rects on every call", () => {
    expect(layout(fixture, file, WIDTH, HEIGHT)).toEqual(rects);
  });

  test("places nothing inside a file too small for a label band", () => {
    const tiny = layout(fixture, file, 3 * LABEL_BAND, 3 * LABEL_BAND);
    expect(tiny).toEqual([{ id: file, x: 0, y: 0, w: 3 * LABEL_BAND, h: 3 * LABEL_BAND, depth: 0 }]);
  });
});

describe("layout rooted at a class or function", () => {
  const square = "class:src/shapes.ts#Square" as NodeId;
  const rects = layout(fixture, square, WIDTH, HEIGHT);
  const rectOf = new Map<NodeId, Rect>(rects.map((rect) => [rect.id, rect]));

  test("fills the viewport with the class and places its methods by line count", () => {
    expect(rectOf.get(square)).toEqual({ id: square, x: 0, y: 0, w: WIDTH, h: HEIGHT, depth: 0 });
    const methods = fixture.nodes.filter((node) => node.parent === square);
    expect(methods.length).toBeGreaterThan(3);
    const totalArea = methods.reduce((sum, node) => sum + area(rectOf.get(node.id)!), 0);
    const totalLines = methods.reduce((sum, node) => sum + lineCount(node), 0);
    for (const node of methods) {
      expect(area(rectOf.get(node.id)!) / totalArea, node.id).toBeCloseTo(lineCount(node) / totalLines, 9);
    }
  });

  test("shows a function with no function inside it as a single rect", () => {
    const leaf = "function:src/util/math.ts#add" as NodeId;
    expect(layout(fixture, leaf, WIDTH, HEIGHT)).toEqual([{ id: leaf, x: 0, y: 0, w: WIDTH, h: HEIGHT, depth: 0 }]);
  });

  test("rejects a root that is not in the graph", () => {
    expect(() => layout(fixture, "file:nope.ts" as NodeId, WIDTH, HEIGHT)).toThrow(/nope\.ts/);
  });
});

describe("layout of a file with known line ranges", () => {
  const source = [
    "function a() {",
    ...Array.from({ length: 28 }, () => "  // body"),
    "}",
    "function b() {",
    ...Array.from({ length: 18 }, () => "  // body"),
    "}",
    ...Array.from({ length: 50 }, () => "// top level"),
    "",
  ].join("\n");
  const graph = extract(new Map([["package.json", "{}\n"], ["a.ts", source]]));
  const rects = layout(graph, "file:a.ts" as NodeId, 400, 300);
  const rectOf = (id: string) => rects.find((rect) => rect.id === id)!;

  test("covers a third of the file with its two functions and leaves the rest as the file's own", () => {
    expect(lineCount(nodeOf(graph, "function:a.ts#a"))).toBe(30);
    expect(lineCount(nodeOf(graph, "function:a.ts#b"))).toBe(20);
    expect(lineCount(nodeOf(graph, "file:a.ts"))).toBe(100);
    const inner = (400 - 2 * INSET) * (300 - LABEL_BAND - INSET);
    expect(area(rectOf("function:a.ts#a")) / inner).toBeCloseTo(0.3, 9);
    expect(area(rectOf("function:a.ts#b")) / inner).toBeCloseTo(0.2, 9);
    expect(rects).toHaveLength(3);
  });
});

describe("ownLines", () => {
  test("is the whole range when nothing is inside it", () => {
    expect(ownLines({ start: 1, end: 10 }, [])).toBe(10);
  });

  test("subtracts the lines of each child", () => {
    expect(ownLines({ start: 1, end: 10 }, [{ start: 2, end: 3 }, { start: 6, end: 9 }])).toBe(4);
  });

  test("counts a line shared by siblings once", () => {
    expect(ownLines({ start: 1, end: 10 }, [{ start: 4, end: 4 }, { start: 4, end: 4 }])).toBe(9);
    expect(ownLines({ start: 1, end: 10 }, [{ start: 2, end: 5 }, { start: 4, end: 7 }])).toBe(4);
  });

  test("is zero when the children cover every line, whatever order they come in", () => {
    expect(ownLines({ start: 5, end: 8 }, [{ start: 7, end: 8 }, { start: 5, end: 7 }])).toBe(0);
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
  const rects = layout(graph, rootOf(graph), WIDTH, HEIGHT);
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
