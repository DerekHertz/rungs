import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { RESOURCE_ORDER } from "../src/graph.ts";
import type { Graph } from "../src/graph.ts";
import { GAP, kindOfRole, LOT, namesAt, pierSpriteName, project, stepOf, stepsOf, townOf } from "../src/town.ts";
import { readFixtureTree } from "./fixture-tree.ts";

/** The names the sheet on the town-sheet branch holds. */
const SHEET = new Set([
  "workshop-1", "workshop-2", "workshop-3", "lab-1", "lab-2", "library", "shed", "warehouse", "hut",
  "port-process", "port-network", "port-file-system", "port-timer",
]);

function fns(count: number): string {
  return Array.from({ length: count }, (_, i) => `function f${i}() {}`).join("\n") + "\n";
}

function syntheticTree(): Map<string, string> {
  const tree = new Map<string, string>([["package.json", "{}\n"], ["README.md", "# hi\n"], ["index.js", fns(2)]]);
  for (let i = 0; i < 30; i++) tree.set(`${["src", "lib", "docs", "test"][i % 4]}/file${i}.${i % 4 === 2 ? "md" : "js"}`, fns((i * 7) % 19));
  tree.set("test/a.test.js", fns(12));
  tree.set("package-lock.json", "{}\n".repeat(50));
  tree.set("src/deep/er/x.js", fns(3));
  tree.set("lib/net.js", 'const { spawn } = require("node:child_process");\nfetch("https://x.test");\nfunction go() { spawn("ls"); }\n');
  tree.set("lib/q.js", 'const fs = require("node:fs");\nfunction r() { return fs.readFileSync("a"); }\n');
  tree.set("lib/t.js", "function t() { setTimeout(() => {}, 5); }\n");
  return tree;
}

const synthetic = extract(syntheticTree());
const small = extract(readFixtureTree(fileURLToPath(new URL("fixtures/small", import.meta.url))));
const graphs: [string, Graph][] = [["a synthetic tree", synthetic], ["the small fixture", small]];

describe("townOf", () => {
  test.each(graphs)("is a pure function of the graph: %s", (_name, graph) => {
    expect(townOf(graph, SHEET)).toEqual(townOf(structuredClone(graph), new Set([...SHEET].reverse())));
  });

  test.each(graphs)("has one lot per file and one block per top-level folder: %s", (_name, graph) => {
    const town = townOf(graph, SHEET);
    const files = graph.nodes.filter((node) => node.level === "file");
    expect(town.lots.map((lot) => lot.id).sort()).toEqual(files.map((file) => file.id).sort());
    const tops = new Set(files.map((file) => (file.path.includes("/") ? file.path.split("/")[0] : "")));
    expect(town.blocks).toHaveLength(tops.size);
    expect(town.blocks.reduce((sum, block) => sum + block.files, 0)).toBe(files.length);
  });

  test("names each block after its top-level folder and gathers loose files in a root block", () => {
    const town = townOf(synthetic, SHEET);
    expect(town.blocks.map((block) => block.name).sort()).toEqual(["(root files)", "docs", "lib", "src", "test"]);
    const byName = new Map(town.blocks.map((block) => [block.name, block]));
    const deep = town.lots.find((lot) => lot.path === "src/deep/er/x.js");
    expect(deep?.block).toBe(byName.get("src")?.id);
    expect(byName.get("src")?.folders.length).toBeGreaterThan(1);
    expect(town.lots.find((lot) => lot.path === "package.json")?.block).toBe(byName.get("(root files)")?.id);
  });

  test("gives every lot the same size and a grid slot in path order, in the block of its own folder", () => {
    const town = townOf(synthetic, SHEET);
    for (const block of [...town.blocks, ...town.nested]) {
      const lots = town.lots.filter((lot) => lot.folder === block.id);
      expect(lots.map((lot) => lot.path)).toEqual(lots.map((lot) => lot.path).sort());
      lots.forEach((lot, index) => {
        const col = index % block.cols;
        const row = Math.floor(index / block.cols);
        expect(lot.X).toBeCloseTo(block.X0 + 0.5 + col * LOT + LOT / 2, 9);
        expect(lot.Y).toBeCloseTo(block.Y1 - 0.5 - row * LOT - LOT / 2, 9);
      });
    }
    const src = town.blocks.find((block) => block.name === "src")!;
    const flat = town.blocks.find((block) => block.name === "docs")!;
    expect(flat.X1 - flat.X0).toBeCloseTo(flat.cols * LOT + 1, 9);
    expect(flat.Y1 - flat.Y0).toBeCloseTo(flat.rows * LOT + 1, 9);
    expect(src.X1 - src.X0).toBeGreaterThan(src.cols * LOT + 1);
  });

  test("packs blocks in rows, largest first, without overlap", () => {
    const town = townOf(synthetic, SHEET);
    const sizes = town.blocks.map((block) => block.files);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    for (const [i, a] of town.blocks.entries()) {
      for (const b of town.blocks.slice(i + 1)) {
        const apart = a.X1 + GAP / 2 <= b.X0 || b.X1 + GAP / 2 <= a.X0 || a.Y1 + GAP / 2 <= b.Y0 || b.Y1 + GAP / 2 <= a.Y0;
        expect(apart).toBe(true);
      }
    }
  });

  test("picks the building kind from the role", () => {
    const town = townOf(synthetic, SHEET);
    const kindOf = (path: string) => town.lots.find((lot) => lot.path === path)?.kind;
    expect(kindOf("src/file0.js")).toBe("workshop");
    expect(kindOf("test/a.test.js")).toBe("lab");
    expect(kindOf("docs/file2.md")).toBe("library");
    expect(kindOf("package.json")).toBe("shed");
    expect(kindOf("package-lock.json")).toBe("warehouse");
    expect(kindOfRole(null)).toBe("hut");
    for (const lot of town.lots) expect(SHEET.has(lot.sprite)).toBe(true);
  });

  test("sizes buildings by classes and functions, never by lines", () => {
    const town = townOf(synthetic, SHEET);
    const lot = (path: string) => town.lots.find((candidate) => candidate.path === path)!;
    const workshops = town.lots.filter((l) => l.kind === "workshop").sort((a, b) => b.functions - a.functions);
    expect(workshops[0]!.functions).toBe(town.counts.most);
    expect(workshops[0]!.step).toBe(3);
    expect(workshops.at(-1)!.step).toBe(1);
    expect(lot("package-lock.json").step).toBe(1);
    expect(lot("package-lock.json").sprite).toBe("warehouse");
  });

  test("a harbour structure stands for each reached kind the sheet has a sprite for", () => {
    const town = townOf(synthetic, SHEET);
    expect(town.piers.map((pier) => pier.kind)).toEqual(["process", "network", "file system", "timer"]);
    expect(town.piers.map((pier) => pier.sprite)).toEqual(["port-process", "port-network", "port-file-system", "port-timer"]);
    expect(town.unpictured).toEqual([]);
  });

  test("a reached kind without a sprite gets no structure, and a kind nothing reaches gets none", () => {
    const town = townOf(synthetic, new Set([...SHEET].filter((name) => name !== "port-timer")));
    expect(town.piers.map((pier) => pier.kind)).toEqual(["process", "network", "file system"]);
    expect(town.unpictured).toEqual(["timer"]);
    expect(townOf(extract(new Map([["a.js", fns(1)]])), SHEET).piers).toEqual([]);
  });

  test("an empty graph is an empty town", () => {
    const town = townOf({ extractorVersion: "x", nodes: [], edges: [], resolutions: [], imports: [], sections: [], manifests: [] }, SHEET);
    expect(town.lots).toEqual([]);
    expect(town.blocks).toEqual([]);
  });
});

describe("size steps", () => {
  test("a square-root scale between the fewest and the most", () => {
    const steps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((count) => stepOf(count, 0, 10, 3));
    expect(steps[0]).toBe(1);
    expect(steps[10]).toBe(3);
    expect(steps).toEqual([...steps].sort());
    // The root scale gives small counts more room than a straight one would: 3 of 10 is already step 2.
    expect(stepOf(3, 0, 10, 3)).toBe(2);
    expect(stepOf(1, 0, 10, 3)).toBe(1);
  });

  test("one size when every file has the same count or the sheet has one size", () => {
    expect(stepOf(4, 4, 4, 3)).toBe(1);
    expect(stepOf(9, 0, 10, 1)).toBe(1);
  });

  test("steps are counted from the sheet", () => {
    expect(stepsOf("workshop", SHEET)).toBe(3);
    expect(stepsOf("lab", SHEET)).toBe(2);
    expect(stepsOf("shed", SHEET)).toBe(1);
    expect(stepsOf("workshop", new Set(["workshop-1", "workshop-2", "workshop-3", "workshop-4"]))).toBe(4);
    expect(stepsOf("hut", new Set())).toBe(0);
    expect(pierSpriteName("file system")).toBe("port-file-system");
    expect(pierSpriteName("code loaded at run time")).toBe("port-dynamic-load");
    expect(RESOURCE_ORDER.map(pierSpriteName)).toEqual(["port-process", "port-network", "port-queue", "port-file-system", "port-timer", "port-dynamic-load"]);
  });
});

describe("camera maths", () => {
  test("names by zoom: blocks far away, files close in", () => {
    expect(namesAt(0.1)).toBe("blocks");
    expect(namesAt(0.6)).toBe("blocks");
    expect(namesAt(1)).toBe("files");
  });

  test("projection is isometric: 2:1 and east is right", () => {
    expect(project(0, 0)).toEqual({ x: 0, y: 0 });
    const right = project(1, 0);
    const far = project(0, 1);
    expect(right.x).toBeGreaterThan(0);
    expect(right.y).toBeGreaterThan(0);
    expect(far.x).toBeGreaterThan(0);
    expect(far.y).toBeLessThan(0);
    expect(right.x / right.y).toBeCloseTo(2, 9);
    expect(project(0, 0, 1).y).toBeLessThan(0);
  });
});

function inside(point: readonly [number, number], loop: readonly (readonly [number, number])[]): boolean {
  let hit = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i]!;
    const [xj, yj] = loop[j]!;
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

describe("the island", () => {
  const trees: [string, Map<string, string>][] = [
    ["1,600 files in one folder", new Map(Array.from({ length: 1600 }, (_, i) => [`src/f${String(i).padStart(4, "0")}.js`, "let a;\n"]))],
    ["one huge block and many tiny ones", new Map([...Array.from({ length: 400 }, (_, i) => [`big/f${i}.js`, "let a;\n"] as const), ...Array.from({ length: 30 }, (_, i) => [`d${i}/x.js`, "let a;\n"] as const)])],
    ["a single file", new Map([["a.js", "let a;\n"]])],
    ["many one-file blocks", new Map(Array.from({ length: 80 }, (_, i) => [`d${i}/x.js`, "let a;\n"]))],
  ];
  test.each(trees)("the lawn and the coast enclose every lot corner and block: %s", (_name, tree) => {
    const town = townOf(extract(tree), SHEET);
    for (const lot of town.lots) {
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const corner: [number, number] = [lot.X + (dx * LOT) / 2, lot.Y + (dy * LOT) / 2];
        expect(inside(corner, town.lawn)).toBe(true);
        expect(inside(corner, town.coast)).toBe(true);
      }
    }
    for (const block of town.blocks) {
      for (const corner of [[block.X0, block.Y0], [block.X1, block.Y0], [block.X0, block.Y1], [block.X1, block.Y1]] as const) expect(inside(corner, town.lawn)).toBe(true);
    }
  });
});

describe("a comparison's picture", () => {
  test("a removed file keeps its lot in path order, and a deleted folder keeps its block", () => {
    const base = extract(new Map([["package.json", "{}\n"], ["src/a.js", fns(1)], ["src/b.js", fns(1)], ["src/c.js", fns(1)], ["gone/x.js", fns(1)]]));
    const head = extract(new Map([["package.json", "{}\n"], ["src/a.js", fns(1)], ["src/c.js", fns(1)]]));
    const picture = pictureOf(head, compare(base, head));
    const town = townOf(picture.graph, SHEET);
    const src = town.blocks.find((block) => block.name === "src")!;
    expect(town.lots.filter((lot) => lot.block === src.id).map((lot) => lot.path)).toEqual(["src/a.js", "src/b.js", "src/c.js"]);
    expect(town.blocks.map((block) => block.name)).toContain("gone");
    const headOnly = townOf(head, SHEET);
    expect(headOnly.lots.some((lot) => lot.path === "src/b.js")).toBe(false);
  });
});
