import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { importanceOf, plinthUnknownOf } from "../src/importance.ts";
import { plinthText } from "../src/page/legend-text.ts";
import { townOf } from "../src/town.ts";
import { waysIn } from "../src/ways-in.ts";

const SPRITES = new Set(["workshop-1", "plinth-1", "plinth-2", "plinth-3", "plinth-4"]);
const idOf = (graph: { nodes: readonly { id: NodeId; level: string; path: string }[] }, path: string): NodeId => graph.nodes.find((node) => node.level === "file" && node.path === path)!.id;
const tree = (extra: Record<string, string>): FileTree => new Map(Object.entries({ "package.json": '{"main":"entry.ts"}\n', ...extra }));

describe("which plinths are drawn as at least this tall", () => {
  test("a file only an unread file may import is marked, by that unread file", () => {
    const graph = extract(tree({ "entry.ts": "export const e = 1;\n", "broken.ts": "export const b = (;\n", "lib.ts": "export const l = 1;\n" }));
    const marked = plinthUnknownOf(graph, importanceOf(graph));
    expect(marked.get(idOf(graph, "lib.ts"))).toEqual([idOf(graph, "broken.ts")]);
    expect(marked.get(idOf(graph, "entry.ts"))).toEqual([idOf(graph, "broken.ts")]);
  });

  test("the unread file itself is not marked by itself, and a file no adapter reads is never marked", () => {
    const graph = extract(tree({ "entry.ts": "export const e = 1;\n", "broken.ts": "export const b = (;\n", "README.md": "# hi\n" }));
    const marked = plinthUnknownOf(graph, importanceOf(graph));
    expect(marked.has(idOf(graph, "broken.ts"))).toBe(false);
    expect(marked.has(idOf(graph, "README.md"))).toBe(false);
  });

  test("two unread files do not mark each other: an unread file has its own look", () => {
    const graph = extract(tree({ "entry.ts": "export const e = 1;\n", "a.ts": "export const x = (;\n", "b.ts": "export const x = (;\n" }));
    const marked = plinthUnknownOf(graph, importanceOf(graph));
    expect(marked.has(idOf(graph, "a.ts"))).toBe(false);
    expect(marked.has(idOf(graph, "b.ts"))).toBe(false);
    expect(marked.get(idOf(graph, "entry.ts"))).toEqual([idOf(graph, "a.ts"), idOf(graph, "b.ts")].sort());
  });

  test("no unread file anywhere: no mark", () => {
    const graph = extract(tree({ "entry.ts": 'import "./lib.ts";\n', "lib.ts": "export const l = 1;\n" }));
    expect(plinthUnknownOf(graph, importanceOf(graph)).size).toBe(0);
  });

  test("a file whose known rests already hold the unread file is not marked for it", () => {
    const graph = extract(tree({ "entry.ts": "export const e = 1;\n", "broken.ts": "export const b = (;\n", "lib.ts": "export const l = 1;\n" }));
    const broken = idOf(graph, "broken.ts");
    const lib = idOf(graph, "lib.ts");
    const marked = plinthUnknownOf(graph, new Map([[lib, [broken]]]));
    expect(marked.has(lib)).toBe(false);
    expect(marked.get(idOf(graph, "entry.ts"))).toEqual([broken]);
  });
});

describe("the town carries the mark and keeps known heights", () => {
  const files = tree({ "entry.ts": 'import "./lib.ts";\n', "lib.ts": "export const l = 1;\n", "other.ts": 'import "./lib.ts";\n', "broken.ts": "export const b = (;\n" });
  const graph = extract(files);
  const cleanFiles = tree({ "entry.ts": 'import "./lib.ts";\n', "lib.ts": "export const l = 1;\n", "other.ts": 'import "./lib.ts";\n' });
  const clean = extract(cleanFiles);

  test("a lot with a known plinth keeps its height and gains the at-least count; unknown is not zero", () => {
    const lot = townOf(graph, SPRITES, null, waysIn(files, graph)).lots.find((l) => l.path === "lib.ts")!;
    const plain = townOf(clean, SPRITES, null, waysIn(cleanFiles, clean)).lots.find((l) => l.path === "lib.ts")!;
    expect(lot.raise).toBe(plain.raise);
    expect(lot.plinth).toBe(plain.plinth);
    expect(lot.plinthAtLeast).toBe(1);
    expect(plain.plinthAtLeast).toBe(0);
  });

  test("a lot with no stone at all is marked too, and the unread file's own lot is not", () => {
    const lots = townOf(graph, SPRITES, null, waysIn(files, graph)).lots;
    const entry = lots.find((l) => l.path === "entry.ts")!;
    expect(entry.plinth).toBeUndefined();
    expect(entry.plinthAtLeast).toBe(1);
    expect(lots.find((l) => l.path === "broken.ts")!.plinthAtLeast).toBe(0);
  });

  test("the legend explains the mark", () => {
    const town = townOf(graph, SPRITES, null, waysIn(files, graph));
    expect(plinthText(town)).toContain("dashed");
    expect(plinthText(town)).toContain("at least");
    expect(plinthText(townOf(clean, SPRITES, null, waysIn(cleanFiles, clean)))).not.toContain("dashed");
  });
});
