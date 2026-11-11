import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { blockLabel, fenceOf, mostlyNew, scaffoldOf, townOf } from "../src/town.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const SHEET = new Set([
  "workshop-1", "workshop-2", "workshop-3", "lab-1", "lab-2", "library", "shed", "warehouse", "hut",
  "scaffold-1", "scaffold-2", "scaffold-3", "scaffold-low", "scaffold-small", "crane", "rubble", "sign", "sign-moved", "fence-x", "fence-y",
]);
const fixture = (name: string) => extract(readFixtureTree(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url))));
const base = fixture("small");
const head = fixture("small-head");
const comparison = compare(base, head);
const lotOf = (town: ReturnType<typeof townOf>, path: string) => town.lots.find((lot) => lot.path === path)!;

describe("marks under a comparison", () => {
  const town = townOf(head, SHEET, comparison);

  test("an altered file has scaffolding of its size, a crane and a name", () => {
    const lot = lotOf(town, "src/shapes.ts");
    expect(lot.change).toBe("altered");
    expect(lot.overlay).toBe(scaffoldOf(lot.sprite, SHEET));
    expect(lot.overlay).not.toBeNull();
    expect(lot.crane).toBe(true);
    expect(lot.named).toBe(true);
  });

  test("an added file has bare earth only: no scaffolding, crane or name", () => {
    const lot = lotOf(town, "src/main.ts");
    expect(lot.change).toBe("added");
    expect([lot.overlay, lot.crane, lot.named, lot.movedTo]).toEqual([null, false, false, null]);
  });

  test("a removed file keeps a lot as rubble, with no name", () => {
    const lot = lotOf(town, "src/index.ts");
    expect(lot.change).toBe("removed");
    expect(lot.sprite).toBe("rubble");
    expect([lot.crane, lot.named, lot.movedTo]).toEqual([false, false, null]);
    expect(lotOf(town, "test/helpers.ts").sprite).toBe("rubble");
  });

  test("a moved file is rubble with a sign at the old path and a plain building at the new one", () => {
    const moved = comparison.changes.find((change) => change.kind === "moved" && change.node.level === "file")!;
    if (moved.kind !== "moved") throw new Error("unreachable");
    const away = town.lots.find((lot) => lot.change === "moved-away")!;
    expect(away.path).toBe(moved.from.path);
    expect(away.sprite).toBe("rubble");
    expect(away.movedTo).toEqual({ id: moved.node.id, path: moved.node.path });
    const arrived = lotOf(town, moved.node.path);
    expect(arrived.change).toBe("moved");
    expect([arrived.crane, arrived.overlay, arrived.named, arrived.movedTo]).toEqual([false, null, false, null]);
  });

  test("an unchanged file has no mark and is not named", () => {
    const lot = lotOf(town, "README.md");
    expect([lot.change, lot.overlay, lot.crane, lot.named]).toEqual(["unchanged", null, false, false]);
  });

  test("with no comparison nothing is marked and every file is named", () => {
    const plain = townOf(head, SHEET);
    expect(plain.comparing).toBe(false);
    for (const lot of plain.lots) expect([lot.change, lot.overlay, lot.crane, lot.named, lot.movedTo]).toEqual(["unchanged", null, false, true, null]);
    for (const block of plain.blocks) expect(block.fence).toBeNull();
  });

  test("is a pure function of the graph and comparison, and the same from a picture's graph", () => {
    expect(townOf(structuredClone(head), new Set([...SHEET].reverse()), structuredClone(comparison))).toEqual(town);
    const viaPicture = townOf(pictureOf(head, comparison).graph, SHEET, comparison);
    expect(viaPicture.lots.map((lot) => [lot.path, lot.change])).toEqual(town.lots.map((lot) => [lot.path, lot.change]));
  });

  test("a mark whose sprite the sheet lacks is left out", () => {
    const bare = townOf(head, new Set([...SHEET].filter((name) => !name.startsWith("scaffold") && name !== "crane")), comparison);
    const lot = lotOf(bare, "src/shapes.ts");
    expect([lot.overlay, lot.crane]).toEqual([null, false]);
  });

  test("counts each block's changes, nested folders included", () => {
    const total = town.blocks.reduce((sum, block) => sum + block.changes.added + block.changes.altered + block.changes.removed + block.changes.moved, 0);
    expect(total).toBe(comparison.changes.filter((change) => change.node.level === "file").length);
  });
});

describe("scaffold by size", () => {
  test("a workshop or lab takes its step, a shed or hut the small, a warehouse the low, a library scaffold-1", () => {
    expect(scaffoldOf("workshop-3", SHEET)).toBe("scaffold-3");
    expect(scaffoldOf("lab-1", SHEET)).toBe("scaffold-1");
    expect(scaffoldOf("shed", SHEET)).toBe("scaffold-small");
    expect(scaffoldOf("hut", SHEET)).toBe("scaffold-small");
    expect(scaffoldOf("library", SHEET)).toBe("scaffold-1");
    expect(scaffoldOf("warehouse", SHEET)).toBe("scaffold-low");
  });
});

describe("a mostly new block", () => {
  const baseTree = new Map<string, string>([["package.json", "{}\n"], ["src/a.js", "function a() {}\n"], ["tools/old.js", "function o() {}\n"]]);
  const headTree = new Map(baseTree);
  for (let i = 0; i < 4; i++) headTree.set(`tools/deep/n${i}.js`, `function n${i}() {}\n`);
  headTree.set("tools/old.js", "function o() { return 1; }\n");
  headTree.set("src/b.js", "function b() {}\n");
  const a = extract(baseTree);
  const b = extract(headTree);
  const town = townOf(b, SHEET, compare(a, b));
  const block = (name: string) => town.blocks.find((candidate) => candidate.name === name)!;

  test("counts nested folders, and fences when more than half are added", () => {
    expect(block("tools").changes).toEqual({ added: 4, altered: 1, removed: 0, moved: 0 });
    expect(block("tools").fence).not.toBeNull();
    expect(block("tools").fence!.text).toBe("tools · 4 new");
    expect(block("src").fence).toBeNull();
    expect(block("(root files)").fence).toBeNull();
  });

  test("exactly half is not more than half", () => {
    expect(mostlyNew(2, 4)).toBe(false);
    expect(mostlyNew(3, 5)).toBe(true);
    expect(mostlyNew(0, 0)).toBe(false);
  });

  test("the fence runs round the whole pad and the sign stands outside it", () => {
    const tools = block("tools");
    const fence = tools.fence!;
    const xs = fence.posts.filter((post) => post.sprite === "fence-x");
    const ys = fence.posts.filter((post) => post.sprite === "fence-y");
    expect(xs.length).toBe(2 * Math.ceil(tools.X1 - tools.X0 - 0.01));
    expect(ys.length).toBe(2 * Math.ceil(tools.Y1 - tools.Y0 - 0.01));
    for (const post of xs) expect(post.Y < tools.Y0 || post.Y > tools.Y1).toBe(true);
    for (const post of ys) expect(post.X < tools.X0 || post.X > tools.X1).toBe(true);
    expect(fence.sign.X).toBeGreaterThan(tools.X1);
    expect(fenceOf(tools, 4)).toEqual(fence);
  });

  test("names blocks with their counts under a comparison, and by file count without one", () => {
    const none = { added: 0, altered: 0, removed: 0, moved: 0 };
    expect(blockLabel(block("tools"), true, true)).toBe("tools · 4 new · 1 altered");
    expect(blockLabel(block("src"), true, false)).toBe("src · 1 new");
    expect(blockLabel({ name: "docs", files: 3, changes: none }, true, true)).toBe("docs");
    expect(blockLabel({ name: "docs", files: 3, changes: none }, false, true)).toBe("docs · 3");
    expect(blockLabel({ name: "docs", files: 3, changes: none }, false, false)).toBe("docs");
  });
});
