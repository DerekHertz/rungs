import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { flyTarget } from "../src/focus.ts";
import { extract } from "../src/extract/extract.ts";
import type { NodeId } from "../src/graph.ts";
import { indexGraph } from "../src/zoom.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const graph = extract(readFixtureTree(fileURLToPath(new URL("fixtures/small", import.meta.url))));
const tree = indexGraph(graph);
const id = (value: string) => value as NodeId;

describe("flyTarget", () => {
  const from = (focus: string, hit: string): string | undefined => flyTarget(id(focus), id(hit));

  test("flies to the district double-clicked, however deep it lies", () => {
    expect(from(tree.root, "folder:src")).toBe("folder:src");
    expect(from(tree.root, "folder:src/util")).toBe("folder:src/util");
    expect(from(tree.root, "folder:packages/widget/assets")).toBe("folder:packages/widget/assets");
  });

  test("flies to a district outside the focus", () => {
    expect(from("folder:src", "folder:packages/widget/src")).toBe("folder:packages/widget/src");
    expect(from("folder:src", "folder:docs")).toBe("folder:docs");
  });

  test("flies out to a district around the focus", () => {
    expect(from("folder:src/util", "folder:src")).toBe("folder:src");
    expect(from("folder:src/util", tree.root)).toBe(tree.root);
  });

  test("goes nowhere when the district is already the focus", () => {
    expect(from("folder:src", "folder:src")).toBeUndefined();
    expect(from(tree.root, tree.root)).toBeUndefined();
  });
});
