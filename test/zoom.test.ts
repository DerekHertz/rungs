import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { NodeId } from "../src/graph.ts";
import { commonDistrict, indexGraph, trail, zoomOut, zoomTarget } from "../src/zoom.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const graph = extract(readFixtureTree(fileURLToPath(new URL("fixtures/small", import.meta.url))));
const tree = indexGraph(graph);
const id = (value: string) => value as NodeId;

describe("trail", () => {
  test("runs from the top of the repository down to the zoomed node", () => {
    expect(trail(tree, id("function:src/shapes.ts#Square.area.squared")).map((node) => node.level)).toEqual([
      "package",
      "folder",
      "file",
      "class",
      "function",
      "function",
    ]);
    expect(trail(tree, id("function:src/shapes.ts#Square.area.squared")).map((node) => node.name).slice(1)).toEqual([
      "src",
      "shapes.ts",
      "Square",
      "area",
      "squared",
    ]);
  });

  test("is just the top of the repository when nothing is zoomed", () => {
    expect(trail(tree, tree.root).map((node) => node.id)).toEqual([tree.root]);
  });
});

describe("zoomOut", () => {
  test("goes up one step, and stays at the top", () => {
    expect(zoomOut(tree, id("class:src/shapes.ts#Square"))).toBe("file:src/shapes.ts");
    expect(zoomOut(tree, id("file:src/shapes.ts"))).toBe("folder:src");
    expect(zoomOut(tree, tree.root)).toBe(tree.root);
  });
});

describe("zoomTarget", () => {
  test("zooms into the deepest rectangle under the cursor that has something inside it", () => {
    expect(zoomTarget(tree, tree.root, id("class:src/shapes.ts#Square"))).toBe("class:src/shapes.ts#Square");
    expect(zoomTarget(tree, tree.root, id("function:src/shapes.ts#Square.area.squared"))).toBe(
      "function:src/shapes.ts#Square.area",
    );
  });

  test("walks up from a rectangle with nothing inside it", () => {
    expect(zoomTarget(tree, tree.root, id("function:src/util/math.ts#add"))).toBe("file:src/util/math.ts");
    expect(zoomTarget(tree, tree.root, id("file:src/util/empty.ts"))).toBe("folder:src/util");
    expect(zoomTarget(tree, tree.root, id("file:README.md"))).toBeUndefined();
  });

  test("never zooms to the rectangle that already fills the window, or out of it", () => {
    const current = id("file:src/shapes.ts");
    expect(zoomTarget(tree, current, current)).toBeUndefined();
    expect(zoomTarget(tree, current, id("function:src/util/math.ts#add"))).toBeUndefined();
    expect(zoomTarget(tree, current, id("function:src/shapes.ts#Circle.radius"))).toBe("class:src/shapes.ts#Circle");
  });
});

describe("commonDistrict", () => {
  test("is the folder of one file, and the nearest folder holding all the files", () => {
    expect(commonDistrict(tree, [id("file:src/shapes.ts")])).toBe("folder:src");
    expect(commonDistrict(tree, [id("file:src/shapes.ts"), id("file:src/index.ts")])).toBe("folder:src");
  });

  test("reaches the top of the repository when the files share nothing else, and is undefined for no files", () => {
    expect(commonDistrict(tree, [id("file:src/shapes.ts"), id("file:package.json")])).toBe(tree.root);
    expect(commonDistrict(tree, [])).toBeUndefined();
  });
});
