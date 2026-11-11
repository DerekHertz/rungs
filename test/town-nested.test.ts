import { describe, expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { allBlocks, blockAtGround, blockLabel, blockNamedAt, FILE_NAMES_FROM_LOT_PX, INNER_GAP, LOT, namesAt, townOf } from "../src/town.ts";
import type { Block, Town } from "../src/town.ts";

const SHEET = new Set(["workshop-1", "workshop-2", "lab-1", "library", "shed", "warehouse", "hut", "rubble", "sign", "fence-x", "fence-y"]);
const isGhost = (change: string) => change === "removed" || change === "moved-away";
const random = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function tree(): Map<string, string> {
  const files = new Map<string, string>([["package.json", "{}\n"]]);
  for (let i = 0; i < 6; i++) files.set(`tools/t${i}.js`, `function t${i}() {}\n`);
  for (let i = 0; i < 5; i++) files.set(`tools/review/r${i}.js`, `function r${i}() {}\n`);
  for (let i = 0; i < 3; i++) files.set(`tools/review/ui/u${i}.js`, `function u${i}() {}\n`);
  for (let i = 0; i < 2; i++) files.set(`tools/review/test/e${i}.js`, `function e${i}() {}\n`);
  for (let i = 0; i < 4; i++) files.set(`tools/docs/d${i}.md`, `# d${i}\n`);
  for (let i = 0; i < 3; i++) files.set(`src/s${i}.js`, `function s${i}() {}\n`);
  return files;
}
const town = townOf(extract(tree()), SHEET);
const named = (name: string): Block => allBlocks(town).find((block) => block.name === name)!;
const inside = (inner: Block, outer: Block, margin = 0): boolean => inner.X0 >= outer.X0 + margin && inner.X1 <= outer.X1 - margin && inner.Y0 >= outer.Y0 + margin && inner.Y1 <= outer.Y1 - margin;

describe("nested blocks", () => {
  test("a folder in a top-level folder is a block within it, one level deeper each time", () => {
    expect(town.blocks.map((block) => block.name).sort()).toEqual(["(root files)", "src", "tools"]);
    expect(town.nested.map((block) => [block.name, block.depth]).sort()).toEqual([["docs", 1], ["review", 1], ["test", 2], ["ui", 2]]);
    expect(named("ui").parent).toBe(named("review").id);
    expect(named("review").parent).toBe(named("tools").id);
    expect(named("tools").parent).toBeNull();
    expect(named("tools").files).toBe(20);
    expect(named("review").files).toBe(10);
  });

  test("a block's own files are a grid, and its subfolders sit inside its pad, clear of the grid, of each other and of the edge", () => {
    for (const block of town.nested) {
      const parent = allBlocks(town).find((candidate) => candidate.id === block.parent)!;
      expect(inside(block, parent, 0.5 - 1e-9)).toBe(true);
      for (const lot of town.lots.filter((candidate) => candidate.folder === parent.id)) {
        const apart = lot.X + LOT / 2 <= block.X0 || block.X1 <= lot.X - LOT / 2 || lot.Y + LOT / 2 <= block.Y0 || block.Y1 <= lot.Y - LOT / 2;
        expect(apart).toBe(true);
      }
      for (const other of town.nested.filter((candidate) => candidate.parent === block.parent && candidate !== block)) {
        const apart = block.X1 + INNER_GAP <= other.X0 + 1e-9 || other.X1 + INNER_GAP <= block.X0 + 1e-9 || block.Y1 + INNER_GAP <= other.Y0 + 1e-9 || other.Y1 + INNER_GAP <= block.Y0 + 1e-9;
        expect(apart).toBe(true);
      }
    }
    for (const lot of town.lots) {
      const block = allBlocks(town).find((candidate) => candidate.id === lot.folder)!;
      expect(lot.X - LOT / 2).toBeGreaterThanOrEqual(block.X0 + 0.5 - 1e-9);
      expect(lot.X + LOT / 2).toBeLessThanOrEqual(block.X1 - 0.5 + 1e-9);
      expect(lot.Y - LOT / 2).toBeGreaterThanOrEqual(block.Y0 + 0.5 - 1e-9);
      expect(lot.Y + LOT / 2).toBeLessThanOrEqual(block.Y1 - 0.5 + 1e-9);
    }
  });

  test("the town knows its root, whose id the block of loose root files shares", () => {
    expect(town.root).not.toBeNull();
    expect(town.blocks.find((block) => block.name === "(root files)")!.id).toBe(town.root);
    expect(allBlocks(town).filter((block) => block.name !== "(root files)").every((block) => block.id !== town.root)).toBe(true);
  });

  test("subfolders are packed largest first", () => {
    const kids = town.nested.filter((block) => block.parent === named("tools").id).map((block) => block.files);
    expect(kids).toEqual([...kids].sort((a, b) => b - a));
  });

  test("every lot is in the top-level block and the folder it stands in", () => {
    const lot = (path: string) => town.lots.find((candidate) => candidate.path === path)!;
    expect(lot("tools/review/ui/u0.js").block).toBe(named("tools").id);
    expect(lot("tools/review/ui/u0.js").folder).toBe(named("ui").id);
    expect(lot("tools/t0.js").folder).toBe(named("tools").id);
    expect(town.lots).toHaveLength(tree().size);
  });

  test("a nested block's folders list itself first, with the folders below it", () => {
    expect(named("review").folders[0]).toBe(named("review").id);
    expect(named("review").folders).toEqual(expect.arrayContaining([named("ui").id, named("test").id]));
    expect(named("tools").folders).toEqual(expect.arrayContaining([named("review").id, named("ui").id, named("docs").id]));
  });

  test("picking a ground point gives the innermost block, so a nested pad picks its folder", () => {
    const ui = named("ui");
    expect(blockAtGround(town, (ui.X0 + ui.X1) / 2, (ui.Y0 + ui.Y1) / 2)?.id).toBe(ui.id);
    const tools = named("tools");
    expect(blockAtGround(town, tools.X0 + 0.1, tools.Y1 - 0.1)?.id).toBe(tools.id);
    expect(blockAtGround(town, 1e6, 0)).toBeUndefined();
  });

  test("island containment holds for nested blocks too", () => {
    const loop = town.lawn;
    const holds = (X: number, Y: number): boolean => {
      let result = false;
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [xi, yi] = loop[i]!;
        const [xj, yj] = loop[j]!;
        if (yi > Y !== yj > Y && X < ((xj - xi) * (Y - yi)) / (yj - yi) + xi) result = !result;
      }
      return result;
    };
    for (const block of allBlocks(town)) for (const [X, Y] of [[block.X0, block.Y0], [block.X1, block.Y0], [block.X0, block.Y1], [block.X1, block.Y1]] as const) expect(holds(X, Y)).toBe(true);
  });
});

describe("names by zoom", () => {
  const zoomFor = (lotPx: number) => lotPx / (2 * LOT * 48 * Math.SQRT1_2);
  test("top-level names always, deeper names one level at a time, all before file names", () => {
    expect(blockNamedAt(zoomFor(10), 0)).toBe(true);
    expect(blockNamedAt(zoomFor(10), 1)).toBe(false);
    const from = [1, 2, 3, 4].map((depth) => {
      let px = 1;
      while (!blockNamedAt(zoomFor(px), depth)) px++;
      return px;
    });
    expect(from).toEqual([...from].sort((a, b) => a - b));
    expect(new Set(from).size).toBe(4);
    for (const px of from) expect(px).toBeLessThan(FILE_NAMES_FROM_LOT_PX);
    expect(namesAt(zoomFor(from[0]!))).toBe("blocks");
  });

  test("a nested block's label carries its counts under a comparison, and the fence rule counts at every level", () => {
    const base = tree();
    const head = new Map(base);
    for (let i = 0; i < 5; i++) head.set(`tools/review/ui/n${i}.js`, `function n${i}() {}\n`);
    const comparison = compare(extract(base), extract(head));
    const compared = townOf(extract(head), SHEET, comparison);
    const find = (name: string) => allBlocks(compared).find((block) => block.name === name)!;
    expect(blockLabel(find("ui"), true, false)).toBe("ui · 5 new");
    // 5 of 8 files in ui are new, 5 of 15 in review, 5 of 25 in tools.
    expect(find("ui").fence?.text).toBe("ui · 5 new");
    expect(find("review").fence).toBeNull();
    expect(find("tools").changes.added).toBe(5);
    expect(find("tools").fence).toBeNull();
  });
});

describe("a comparison overlays the head's town at every nesting level", () => {
  const relative = (t: Town) => {
    const all = allBlocks(t);
    return all.map((block) => {
      const parent = all.find((candidate) => candidate.id === block.parent);
      return {
        id: block.id,
        x: parent === undefined ? 0 : +(block.X0 - parent.X0).toFixed(6),
        lots: t.lots.filter((lot) => lot.folder === block.id && !isGhost(lot.change)).map((lot) => [lot.path, +(lot.X - block.X0).toFixed(6), +(block.Y1 - lot.Y).toFixed(6)]),
      };
    });
  };
  test.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])("head lots keep their place in their block, and nested blocks their order and place across (seed %i)", (seed) => {
    const next = random(seed);
    const base = new Map<string, string>([["package.json", "{}\n"]]);
    for (const dir of ["src", "src/a", "src/a/b", "src/c", "lib", "lib/x"]) {
      const count = 2 + Math.floor(next() * 8);
      for (let i = 0; i < count; i++) base.set(`${dir}/f${i}.js`, `function f${i}() { return ${i}; }\n`);
    }
    const head = new Map(base);
    for (const path of base.keys()) if (path !== "package.json" && next() < 0.4) head.delete(path);
    if (seed % 3 === 0) for (const path of [...head.keys()].filter((p) => p.startsWith("src/a/"))) head.delete(path);
    const after = extract(head);
    const comparison = compare(extract(base), after);
    const plain = townOf(after, SHEET);
    const compared = townOf(pictureOf(after, comparison).graph, SHEET, comparison);
    const plainIds = new Set(allBlocks(plain).map((block) => block.id));
    const before = relative(plain);
    const overlaid = relative(compared).filter((entry) => plainIds.has(entry.id));
    expect(overlaid.map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
    for (const [index, entry] of overlaid.entries()) {
      expect(entry.lots).toEqual(before[index]!.lots);
      expect(entry.x).toBe(before[index]!.x);
    }
    // Rubble stands after the head's lots in its top-level block, and blocks only rubble stands in have only rubble.
    for (const block of compared.blocks) {
      const flags = compared.lots.filter((lot) => lot.block === block.id).map((lot) => Number(isGhost(lot.change)));
      expect(flags).toEqual([...flags].sort((x, y) => x - y));
    }
    for (const block of allBlocks(compared).filter((candidate) => !plainIds.has(candidate.id))) {
      expect(compared.lots.filter((lot) => lot.folder === block.id).every((lot) => isGhost(lot.change))).toBe(true);
    }
  });

  test("rubble of a nested folder stands in its top-level block's foot or yard", () => {
    const base = tree();
    const head = new Map(base);
    head.delete("tools/review/ui/u0.js");
    const after = extract(head);
    const comparison = compare(extract(base), after);
    const compared = townOf(pictureOf(after, comparison).graph, SHEET, comparison);
    const rubble = compared.lots.find((lot) => lot.path === "tools/review/ui/u0.js")!;
    // At the foot of its block when that clears the blocks round it, in a yard of rubble named alike when not.
    const tools = compared.blocks.find((block) => block.id === rubble.block)!;
    expect(tools.name).toBe("tools");
    expect(rubble.change).toBe("removed");
    expect(rubble.X).toBeGreaterThan(tools.X0);
    expect(rubble.X).toBeLessThan(tools.X1);
    expect(rubble.Y).toBeGreaterThan(tools.Y0);
    expect(rubble.Y).toBeLessThan(tools.Y1);
  });

  const absolute = (t: Town) => new Map(t.lots.filter((lot) => !isGhost(lot.change)).map((lot) => [lot.path, [+lot.X.toFixed(6), +lot.Y.toFixed(6)]]));
  const overlap = (a: Block, b: Block) => a.X0 < b.X1 && b.X0 < a.X1 && a.Y0 < b.Y1 && b.Y0 < a.Y1;

  test("rubble in one nested folder moves no head lot, in absolute coordinates", () => {
    const base = new Map<string, string>([["package.json", "{}\n"]]);
    for (const dir of ["a", "b", "c"]) base.set(`src/${dir}/keep.js`, "function k() {}\n");
    base.set("src/a/gone.js", "function g() {}\n");
    const head = new Map(base);
    head.delete("src/a/gone.js");
    const after = extract(head);
    const comparison = compare(extract(base), after);
    const plain = townOf(after, SHEET);
    const compared = townOf(pictureOf(after, comparison).graph, SHEET, comparison);
    expect(absolute(compared)).toEqual(absolute(plain));
    const all = allBlocks(compared);
    for (const [i, a] of compared.blocks.entries()) for (const b of compared.blocks.slice(i + 1)) expect(overlap(a, b)).toBe(false);
    for (const lot of compared.lots) expect(all.some((block) => lot.X > block.X0 && lot.X < block.X1 && lot.Y > block.Y0 && lot.Y < block.Y1)).toBe(true);
  });

  test.each([21, 22, 23, 24, 25, 26, 27, 28])("head lots stay put in absolute coordinates, and blocks never overlap, over random nested deletions (seed %i)", (seed) => {
    const next = random(seed);
    const base = new Map<string, string>([["package.json", "{}\n"]]);
    for (const dir of ["src", "src/a", "src/a/b", "src/c", "src/d", "lib", "lib/x", "lib/y", "docs"]) {
      const count = 1 + Math.floor(next() * 7);
      for (let i = 0; i < count; i++) base.set(`${dir}/f${i}.js`, `function f${i}() { return ${i}; }\n`);
    }
    const head = new Map(base);
    for (const path of base.keys()) if (path !== "package.json" && next() < 0.35) head.delete(path);
    const after = extract(head);
    const comparison = compare(extract(base), after);
    const plain = townOf(after, SHEET);
    const compared = townOf(pictureOf(after, comparison).graph, SHEET, comparison);
    expect(absolute(compared)).toEqual(absolute(plain));
    for (const [i, a] of compared.blocks.entries()) for (const b of compared.blocks.slice(i + 1)) expect(overlap(a, b)).toBe(false);
    const lots = compared.lots;
    for (const [i, a] of lots.entries()) for (const b of lots.slice(i + 1)) expect(Math.abs(a.X - b.X) >= LOT - 1e-6 || Math.abs(a.Y - b.Y) >= LOT - 1e-6).toBe(true);
  });
});
