import { describe, expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { NodeId } from "../src/graph.ts";
import { allBlocks, blockFor, standingBlock, townOf, zoomLimits } from "../src/town.ts";
import type { Town } from "../src/town.ts";

const SHEET = new Set(["workshop-1", "workshop-2", "lab-1", "library", "shed", "warehouse", "hut", "rubble", "sign", "fence-x", "fence-y"]);
const compared = (base: Map<string, string>, head: Map<string, string>): { plain: Town; town: Town } => {
  const after = extract(head);
  const comparison = compare(extract(base), after);
  return { plain: townOf(after, SHEET), town: townOf(pictureOf(after, comparison).graph, SHEET, comparison) };
};

describe("town navigation edges", () => {
  test("ghosts never move an unchanged block (#124 item 1)", () => {
    const base = new Map<string, string>([["package.json", "{}\n"]]);
    for (const dir of ["a", "b", "c"]) for (let i = 1; i <= 4; i++) base.set(`${dir}/${i}.js`, `function f${i}() {}\n`);
    const head = new Map(base);
    for (let i = 1; i <= 3; i++) head.delete(`a/${i}.js`);
    const { plain, town } = compared(base, head);
    const box = (block: Town["blocks"][number]) => [block.id, +block.X0.toFixed(6), +block.Y0.toFixed(6), +block.X1.toFixed(6)];
    // A block rubble stands in grows at its foot by design; every other block stays exactly where the head town has it.
    const untouched = (t: Town) => t.blocks.filter((block) => block.changes.removed === 0 && block.name !== "a").map(box);
    expect(untouched(town)).toEqual(untouched(plain));
    expect(untouched(town)).toHaveLength(3);
  });

  test("a real folder named like an overflow yard does not share its id (#134 item 1)", () => {
    const base = new Map<string, string>([["package.json", "{}\n"]]);
    for (const dir of ["a", "a~rubble", "b", "c", "d"]) base.set(`${dir}/keep.js`, "function k() {}\n");
    base.set("a~rubble/gone.js", "function g() {}\n");
    base.set("a/gone.js", "function g() {}\n");
    const head = new Map(base);
    head.delete("a/gone.js");
    head.delete("a~rubble/gone.js");
    const { town } = compared(base, head);
    const ids = allBlocks(town).map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const path of ["a/gone.js", "a~rubble/gone.js"]) expect(town.lots.filter((lot) => lot.path === path)).toHaveLength(1);
  });

  test("the block where a removed file's rubble stands is found from the file (#134 item 2, #135 item 2)", () => {
    const base = new Map<string, string>([["package.json", "{}\n"]]);
    for (const dir of ["a", "b", "c", "d"]) base.set(`${dir}/keep.js`, "function k() {}\n");
    base.set("a/dead/gone.js", "function g() {}\n");
    const head = new Map(base);
    head.delete("a/dead/gone.js");
    const { town } = compared(base, head);
    const rubble = town.lots.find((lot) => lot.path === "a/dead/gone.js")!;
    const where = standingBlock(town, [rubble.id])!;
    expect(where.id).toBe(rubble.folder);
    expect(rubble.X).toBeGreaterThan(where.X0);
    expect(rubble.X).toBeLessThan(where.X1);
    expect(rubble.Y).toBeGreaterThan(where.Y0);
    expect(rubble.Y).toBeLessThan(where.Y1);
    expect(standingBlock(town, ["file:nope" as NodeId])).toBeUndefined();
  });

  test("standingBlock of files in different blocks is their smallest shared block, or none", () => {
    const base = new Map<string, string>([["package.json", "{}\n"], ["src/a/x.js", "function x() {}\n"], ["src/b/y.js", "function y() {}\n"], ["lib/z.js", "function z() {}\n"]]);
    const { plain } = compared(base, base);
    const id = (path: string) => plain.lots.find((lot) => lot.path === path)!.id;
    expect(standingBlock(plain, [id("src/a/x.js"), id("src/b/y.js")])?.name).toBe("src");
    expect(standingBlock(plain, [id("src/a/x.js"), id("lib/z.js")])).toBeUndefined();
    expect(standingBlock(plain, [id("src/a/x.js")])?.name).toBe("a");
  });

  test("a folder id finds its smallest block, and the root none", () => {
    const base = new Map<string, string>([["package.json", "{}\n"], ["src/a/x.js", "function x() {}\n"], ["src/y.js", "function y() {}\n"]]);
    const { plain } = compared(base, base);
    expect(blockFor(plain, "folder:src/a" as NodeId)?.name).toBe("a");
    expect(blockFor(plain, plain.root!)).toBeUndefined();
  });

  test("zoom limits scale with the device pixel ratio (#122 item 2)", () => {
    expect(zoomLimits(0.4, 2).max).toBe(zoomLimits(0.4, 1).max * 2);
    expect(zoomLimits(5, 1).max).toBe(5);
    expect(zoomLimits(0.4, 1).min).toBeLessThan(0.4);
    expect(zoomLimits(0.8, 2).min).toBeCloseTo(zoomLimits(0.4, 1).min * 2);
  });
});
