import { describe, expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { townOf } from "../src/town.ts";
import type { Town } from "../src/town.ts";

const SHEET = new Set(["workshop-1", "workshop-2", "workshop-3", "lab-1", "lab-2", "library", "shed", "warehouse", "hut", "rubble", "sign-moved"]);

// A small deterministic generator, so a failing case can be replayed.
const random = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const isGhost = (change: string) => change === "removed" || change === "moved-away";

const relative = (town: Town) =>
  town.blocks.map((block) => ({
    block: block.id,
    lots: town.lots
      .filter((lot) => lot.block === block.id && !isGhost(lot.change))
      .map((lot) => [lot.path, +(lot.X - block.X0).toFixed(6), +(block.Y1 - lot.Y).toFixed(6)]),
  }));

describe("a comparison overlays the head's town", () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])("head lots keep their place in their block, and blocks their order, over random deletions (seed %i)", (seed) => {
    const next = random(seed);
    const tree = new Map<string, string>([["package.json", "{}\n"]]);
    for (const dir of ["src", "lib", "docs", "tools"]) {
      const count = 2 + Math.floor(next() * 9);
      for (let i = 0; i < count; i++) tree.set(`${dir}/f${i}.js`, `function f${i}${dir}() { return ${i}; }\n`);
    }
    const headTree = new Map(tree);
    for (const path of tree.keys()) if (path !== "package.json" && next() < 0.4) headTree.delete(path);
    if (seed % 2 === 0) for (const path of [...headTree.keys()].filter((p) => p.startsWith("tools/"))) headTree.delete(path);
    const before = extract(tree);
    const after = extract(headTree);
    const comparison = compare(before, after);
    const plain = townOf(after, SHEET);
    const compared = townOf(pictureOf(after, comparison).graph, SHEET, comparison);
    const plainOrder = plain.blocks.map((block) => block.id);
    expect(compared.blocks.map((block) => block.id).slice(0, plainOrder.length)).toEqual(plainOrder);
    // Blocks only ghosts stand in come after every head block.
    for (const block of compared.blocks.slice(plainOrder.length)) {
      expect(compared.lots.filter((lot) => lot.block === block.id).every((lot) => isGhost(lot.change))).toBe(true);
    }
    expect(relative(compared).filter((entry) => plainOrder.includes(entry.block))).toEqual(relative(plain));
    // In every block the ghosts stand after the head's files.
    for (const block of compared.blocks) {
      const ghosts = compared.lots.filter((lot) => lot.block === block.id).map((lot) => Number(isGhost(lot.change)));
      expect(ghosts).toEqual([...ghosts].sort((a, b) => a - b));
    }
  });

  test("deleting the first file of a block moves no other lot", () => {
    const tree = new Map<string, string>([["package.json", "{}\n"]]);
    for (const name of ["a", "b", "c", "d"]) tree.set(`src/${name}.js`, `function ${name}() {}\n`);
    const headTree = new Map(tree);
    headTree.delete("src/a.js");
    const before = extract(tree);
    const after = extract(headTree);
    const comparison = compare(before, after);
    const compared = townOf(pictureOf(after, comparison).graph, SHEET, comparison);
    const plain = townOf(after, SHEET);
    const at = (town: Town, name: string) => {
      const block = town.blocks.find((candidate) => candidate.name === "src")!;
      const lot = town.lots.find((candidate) => candidate.path === `src/${name}.js`)!;
      return [lot.X - block.X0, block.Y1 - lot.Y];
    };
    for (const name of ["b", "c", "d"]) {
      at(compared, name).forEach((value, axis) => expect(value).toBeCloseTo(at(plain, name)[axis]!, 9));
    }
  });

  test("a folder whose files all moved keeps a block after the head's, with rubble in it", () => {
    const tree = new Map<string, string>([["package.json", "{}\n"], ["old/a.js", "function a() {}\n"], ["keep/k.js", "function k() {}\n"]]);
    const headTree = new Map(tree);
    headTree.delete("old/a.js");
    headTree.set("new/a.js", "function a() {}\n");
    const before = extract(tree);
    const after = extract(headTree);
    const comparison = compare(before, after);
    const town = townOf(pictureOf(after, comparison).graph, SHEET, comparison);
    expect(town.blocks.at(-1)!.name).toBe("old");
    expect(town.lots.find((lot) => lot.block === town.blocks.at(-1)!.id)!.change).toBe("moved-away");
  });
});
