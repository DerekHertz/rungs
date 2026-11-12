import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import type { NodeId } from "../src/graph.ts";
import { importanceOf, reachedFrom } from "../src/importance.ts";
import { compare } from "../src/compare.ts";
import { townOf } from "../src/town.ts";
import { waysIn } from "../src/ways-in.ts";

const tree = new Map<string, string>([
  ["package.json", JSON.stringify({ main: "main.js" })],
  ["main.js", 'import { a } from "./a.js";\nexport const m = a;\n'],
  ["a.js", 'import { b } from "./b.js";\nimport { T } from "./types.ts";\nexport const a = b;\n'],
  ["b.js", 'import { a } from "./a.js";\nexport const b = 1;\nexport const c = a;\n'],
  ["types.ts", "export type T = number;\n"],
  ["orphan.js", 'import { b } from "./b.js";\nexport const o = b;\n'],
  ["alone.js", "export const z = 1;\n"],
  ["README.md", "# hi\n"],
]);
const graph = extract(tree);
const path = (id: NodeId): string => graph.nodes.find((node) => node.id === id)!.path;
const id = (p: string): NodeId => graph.nodes.find((node) => node.level === "file" && node.path === p)!.id;

describe("importanceOf", () => {
  test("is the reverse transitive closure over file imports, never the file itself, cycles included", () => {
    const rests = importanceOf(graph);
    expect(rests.get(id("b.js"))!.map(path).sort()).toEqual(["a.js", "main.js", "orphan.js"]);
    expect(rests.get(id("a.js"))!.map(path).sort()).toEqual(["b.js", "main.js", "orphan.js"]);
    expect(rests.get(id("types.ts"))!.map(path).sort()).toEqual(["a.js", "b.js", "main.js", "orphan.js"]);
    expect(rests.has(id("alone.js"))).toBe(false);
    expect(rests.has(id("main.js"))).toBe(false);
  });
});

describe("reachedFrom", () => {
  test("follows imports forward from the ways in; a file nothing reaches is absent", () => {
    const reached = reachedFrom(graph, waysIn(tree, graph).map((way) => way.id));
    expect([...reached].map(path).sort()).toEqual(["README.md", "a.js", "b.js", "main.js", "package.json", "types.ts"]);
  });
});

describe("a comparison's ghosts", () => {
  const head = new Map<string, string>([["package.json", JSON.stringify({ main: "main.js" })], ["main.js", "export const m = 1;\n"]]);
  const base = new Map<string, string>([...head, ["removed.js", 'import { m } from "./main.js";\nexport const r = m;\n'], ["gone.md", "# gone\n"]]);
  const headGraph = extract(head);
  const sprites = new Set(["workshop-1", "library", "shed", "hut", "plinth-1", "gate"]);
  const town = townOf(headGraph, sprites, compare(extract(base), headGraph), waysIn(head, headGraph));

  test("a removed file has a lot but is never unreached, never counted, and nothing rests on it", () => {
    const ghost = town.lots.find((lot) => lot.path === "removed.js")!;
    expect(ghost).toBeDefined();
    expect(ghost.reached).toBe(true);
    expect(ghost.restsOn).toEqual([]);
    expect(town.unreached).toBe(0);
    expect(town.lots.find((lot) => lot.path === "main.js")!.restsOn).toEqual([]);
  });
});

describe("the town's lots", () => {
  const sprites = new Set(["workshop-1", "hut", "shed", "plinth-1", "plinth-2", "plinth-3", "plinth-4", "gate"]);
  const town = townOf(graph, sprites, null, waysIn(tree, graph));
  const lot = (p: string) => town.lots.find((candidate) => candidate.path === p)!;

  test("a plinth stands where files rest on a file, tallest for the most, none for none", () => {
    expect(lot("alone.js").plinth).toBeUndefined();
    expect(lot("alone.js").raise).toBe(0);
    expect(lot("b.js").restsOn).toEqual(["a.js", "main.js", "orphan.js"]);
    expect(lot("a.js").plinth).toBe("plinth-1");
    expect(lot("types.ts").plinth).toBe("plinth-4");
    expect(lot("types.ts").raise).toBeGreaterThan(lot("a.js").raise);
  });

  test("a gate stands at a declared way in; footpaths reach what a way in reaches", () => {
    expect(lot("main.js").gate).toBe(true);
    expect(lot("package.json").gate).toBe(false);
    expect(lot("main.js").wayIn).toEqual(["package.json main"]);
    expect(lot("b.js").reached).toBe(true);
    expect(lot("orphan.js").reached).toBe(false);
    expect(lot("README.md").reached).toBe(true);
    expect(town.unreached).toBe(2);
    expect(town.unreached).toBe(town.lots.filter((candidate) => !candidate.reached).length);
  });
});
