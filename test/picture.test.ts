import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { cityOf } from "../src/city.ts";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { rootOf } from "../src/graph.ts";
import type { FileTree, Graph, NodeId } from "../src/graph.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const fixtureUrl = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const base = extract(readFixtureTree(fixtureUrl("small")));
const head = extract(readFixtureTree(fixtureUrl("small-head")));
const comparison = compare(base, head);
const picture = pictureOf(head, comparison);
const treeGraph = (files: Record<string, string>): Graph => extract(new Map(Object.entries(files)) as FileTree);
const id = (text: string) => text as NodeId;
const byId = (graph: Graph) => new Map(graph.nodes.map((node) => [node.id, node]));
const headIds = new Set(head.nodes.map((node) => node.id));
const ghostIds = picture.graph.nodes.filter((node) => !headIds.has(node.id)).map((node) => node.id);

describe("pictureOf without a comparison", () => {
  test("is the head graph itself with no overlay", () => {
    const plain = pictureOf(head, null);
    expect(plain.graph).toBe(head);
    expect(plain.overlay).toBeNull();
  });

  test("lays out the same city it always did (golden from before comparisons existed)", () => {
    const plain = JSON.parse(JSON.stringify(cityOf(pictureOf(head, null), rootOf(head)))) as Record<string, unknown>;
    const stripped = JSON.parse(
      JSON.stringify(plain, (key, value: unknown) => (["change", "tally", "ghost", "compared"].includes(key) ? undefined : value)),
    );
    expect(stripped).toEqual(JSON.parse(readFileSync(fixtureUrl("../golden/city-plain.json"), "utf8")));
  });
});

describe("pictureOf under the small fixture's comparison", () => {
  test("is the head graph followed by exactly the ghosts: removed files, all their classes and functions (move origins included), and the removed folders they stood in", () => {
    expect(picture.graph.nodes.slice(0, head.nodes.length)).toEqual(head.nodes);
    expect([...ghostIds].sort()).toEqual([
      "file:docs/notes.md",
      "file:src/index.ts",
      "file:test/helpers.ts",
      "folder:test",
      "function:src/index.ts#main",
      "function:test/helpers.ts#double",
    ]);
  });

  test("a ghost is the base node as the base graph has it, apart from where it stands", () => {
    const baseNodes = byId(base);
    for (const node of picture.graph.nodes.filter((n) => !headIds.has(n.id))) {
      expect({ ...node, parent: null }).toEqual({ ...baseNodes.get(node.id)!, parent: null });
    }
  });

  test("a ghost stands in the head's directory at its path, or in a ghost one", () => {
    const nodes = byId(picture.graph);
    const parentOf = (node: string) => (nodes.get(id(node)) as { parent: NodeId }).parent;
    expect(parentOf("file:docs/notes.md")).toBe("folder:docs");
    expect(parentOf("file:src/index.ts")).toBe("folder:src");
    expect(parentOf("file:test/helpers.ts")).toBe("folder:test");
    expect(parentOf("folder:test")).toBe(rootOf(head));
    expect(parentOf("function:src/index.ts#main")).toBe("file:src/index.ts");
  });

  test("every node has a unique id and a parent in the graph, and every change has a place", () => {
    const nodes = byId(picture.graph);
    expect(nodes.size).toBe(picture.graph.nodes.length);
    for (const node of picture.graph.nodes) {
      if (node.parent !== null) expect(nodes.has(node.parent), node.id).toBe(true);
    }
    for (const change of comparison.changes) {
      const place = nodes.has(change.node.id) ? change.node.id : id(`file:${change.node.path}`);
      expect(nodes.has(place), change.node.id).toBe(true);
    }
  });

  test("the overlay names each module's change, and unchanged for the rest", () => {
    const overlay = picture.overlay!;
    expect(overlay.change(id("file:src/shapes.ts"))).toBe("altered");
    expect(overlay.change(id("file:src/main.ts"))).toBe("added");
    expect(overlay.change(id("file:src/compat/legacy.js"))).toBe("moved");
    expect(overlay.change(id("file:src/index.ts"))).toBe("removed");
    expect(overlay.change(id("file:README.md"))).toBe("unchanged");
    expect(overlay.change(id("file:nothing"))).toBe("unchanged");
    expect(overlay.entry(id("file:src/index.ts"))?.kind).toBe("removed");
    expect(overlay.entry(id("file:README.md"))).toBeUndefined();
  });

  test("a district counts the files changed below it, ghosts included, and a file counts its code", () => {
    const tally = picture.overlay!.tally;
    expect(tally(rootOf(head))).toEqual({ added: 7, altered: 2, removed: 3, moved: 1 });
    expect(tally(id("folder:test"))).toEqual({ added: 0, altered: 0, removed: 1, moved: 0 });
    expect(tally(id("folder:src"))).toEqual({ added: 3, altered: 2, removed: 1, moved: 1 });
    expect(tally(id("file:src/util/math.ts"))).toEqual({ added: 1, altered: 1, removed: 0, moved: 0 });
    expect(tally(id("file:src/index.ts"))).toEqual({ added: 0, altered: 0, removed: 1, moved: 0 });
    expect(tally(id("file:src/compat/legacy.js"))).toEqual({ added: 0, altered: 0, removed: 0, moved: 1 });
    expect(tally(id("file:README.md"))).toEqual({ added: 0, altered: 0, removed: 0, moved: 0 });
    expect(tally(id("function:src/util/math.ts#add"))).toEqual({ added: 0, altered: 0, removed: 0, moved: 0 });
  });

  test("is a pure function of head and comparison", () => {
    const again = pictureOf(head, compare(base, head));
    expect(again.graph).toEqual(picture.graph);
    expect(cityOf(again, rootOf(head))).toEqual(cityOf(picture, rootOf(head)));
  });
});

describe("a function removed from a file that stays", () => {
  const before = treeGraph({ "a.ts": "export function keep() {}\nexport function drop() {}\nexport function drop2() {}\n" });
  const after = treeGraph({ "a.ts": "export function keep() {}\n" });
  const changed = compare(before, after);
  const pic = pictureOf(after, changed);

  test("is in the changes and the file's tally, but not in the graph", () => {
    expect(changed.changes.map((c) => `${c.kind} ${c.node.id}`)).toContain("removed function:a.ts#drop");
    expect(pic.graph.nodes.map((n) => n.id)).toEqual(after.nodes.map((n) => n.id));
    expect(pic.overlay!.tally(id("file:a.ts"))).toEqual({ added: 0, altered: 0, removed: 2, moved: 0 });
  });

  test("leaves the file as tall as its head code says", () => {
    const city = cityOf(pic, rootOf(after));
    expect(city.buildings.find((b) => b.id === "file:a.ts")!.functions).toBe(1);
  });
});

describe("a removed file moves its lines into the layout at its old height", () => {
  const before = treeGraph({
    "keep.ts": "export function a() {}\n".repeat(5),
    "gone.ts": "export function x() {}\nexport function y() {}\nexport function z() {}\n".repeat(1),
  });
  const after = treeGraph({ "keep.ts": "export function a() {}\n".repeat(5) });
  const pic = pictureOf(after, compare(before, after));

  test("a ghost takes room by its base lines and counts its base functions", () => {
    const city = cityOf(pic, rootOf(after));
    const ghost = city.buildings.find((b) => b.id === "file:gone.ts")!;
    expect(ghost.change).toBe("removed");
    expect(ghost.functions).toBe(3);
    expect(ghost.w * ghost.d).toBeGreaterThan(0);
    expect(city.buildings.map((b) => b.id).sort()).toEqual(["file:gone.ts", "file:keep.ts"]);
  });
});

describe("ghosts carry everything their base file had", () => {
  const ghostsOf = (before: Record<string, string>, after: Record<string, string>) => {
    const b = treeGraph(before);
    const a = treeGraph(after);
    const pic = pictureOf(a, compare(b, a));
    const had = new Set(a.nodes.map((n) => n.id));
    return { pic, city: cityOf(pic, rootOf(a)), ghosts: pic.graph.nodes.filter((n) => !had.has(n.id)).map((n) => n.id).sort() };
  };

  test("a function that moved out of a removed file is still in its ghost", () => {
    const { ghosts, city } = ghostsOf(
      { "old/a.ts": "export function keep() {}\nexport function moved() {\n  return 1;\n}\n", "b.ts": "export const x = 1;\n" },
      { "b.ts": "export const x = 1;\nexport function moved() {\n  return 1;\n}\n" },
    );
    expect(ghosts).toContain("function:old/a.ts#keep");
    expect(ghosts).toContain("function:old/a.ts#moved");
    expect(city.buildings.find((b) => b.id === "file:old/a.ts")!.functions).toBe(2);
  });

  test("nested code in a removed file is kept whatever order the ids sort in", () => {
    const { ghosts } = ghostsOf(
      { "gone.ts": "export function f() { class C { m() {} } return C; }\n", "k.ts": "export const k = 1;\n" },
      { "k.ts": "export const k = 1;\n" },
    );
    expect(ghosts).toEqual(
      expect.arrayContaining(["file:gone.ts", "function:gone.ts#f", "class:gone.ts#f.C", "function:gone.ts#f.C.m"]),
    );
  });

  test("a directory whose files all moved leaves no empty ghost district", () => {
    const { ghosts, pic } = ghostsOf(
      { "old/a.ts": "export function a() {}\n", "k.ts": "export const k = 1;\n" },
      { "new/a.ts": "export function a() {}\n", "k.ts": "export const k = 1;\n" },
    );
    expect(ghosts).toEqual([]);
    expect(pic.graph.nodes.some((n) => n.id === "folder:old")).toBe(false);
  });
});
