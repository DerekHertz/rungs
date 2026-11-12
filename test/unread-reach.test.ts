import { describe, expect, test } from "vitest";
import { definingHeading, fileWhy, whyLine } from "../src/defining.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { possiblyReachedFrom, reachedFrom } from "../src/importance.ts";
import { harbourText, plinthText, waysText } from "../src/page/legend-text.ts";
import { readableComparison } from "../src/readable.ts";
import { townOf } from "../src/town.ts";
import { waysIn } from "../src/ways-in.ts";

const SPRITES = new Set(["workshop-1", "workshop-2", "workshop-3", "lab-1", "lab-2", "hut", "library", "shed", "warehouse"]);
const idOf = (graph: { nodes: readonly { id: NodeId; level: string; path: string }[] }, path: string): NodeId => graph.nodes.find((node) => node.level === "file" && node.path === path)!.id;
const base = (extra: Record<string, string>): FileTree => new Map(Object.entries({ "package.json": '{"main":"entry.ts"}\n', "unused.ts": "export const u = 1;\n", ...extra }));

describe("known reach and unknown reach stay apart", () => {
  test("an unread file no way in reaches does not make every file reached", () => {
    const graph = extract(base({ "entry.ts": "export const e = 1;\n", "broken.ts": "export const b = (;\n" }));
    const ways = [idOf(graph, "entry.ts")];
    expect(reachedFrom(graph, ways).has(idOf(graph, "unused.ts"))).toBe(false);
    expect(reachedFrom(graph, ways).has(idOf(graph, "broken.ts"))).toBe(false);
    expect(possiblyReachedFrom(graph, ways).size).toBe(0);
    const town = townOf(graph, SPRITES, null, waysIn(base({ "entry.ts": "export const e = 1;\n", "broken.ts": "export const b = (;\n" }), graph));
    expect(town.lots.find((lot) => lot.path === "unused.ts")).toMatchObject({ reached: false, reachUnknown: false });
    expect(town.unreached).toBeGreaterThan(0);
  });

  test("an unread file a way in reaches makes the rest possibly reached, not reached", () => {
    const files = base({ "entry.ts": 'import "./broken.ts";\n', "broken.ts": "export const b = (;\n" });
    const graph = extract(files);
    const ways = [idOf(graph, "entry.ts")];
    expect(reachedFrom(graph, ways).has(idOf(graph, "broken.ts"))).toBe(true);
    expect(reachedFrom(graph, ways).has(idOf(graph, "unused.ts"))).toBe(false);
    expect(possiblyReachedFrom(graph, ways).has(idOf(graph, "unused.ts"))).toBe(true);
    const town = townOf(graph, SPRITES, null, waysIn(files, graph));
    expect(town.lots.find((lot) => lot.path === "unused.ts")).toMatchObject({ reached: false, reachUnknown: true });
    expect(town.unreached).toBe(0);
    expect(town.reachUnknown).toBe(1);
    expect(waysText(town)).toContain("1 code file could be reached through a file that could not be read");
    expect(waysText(town)).not.toContain("0 code files have none");
  });

  test("no test reaches it is not said while a test file could not be read", () => {
    const files = new Map([["package.json", "{}\n"], ["lib.ts", "export function f(a: number) {\n  return a;\n}\n"], ["lib.test.ts", "export const t = (;\n"]]);
    const changed = new Map(files).set("lib.ts", "export function f(a: number, b: number) {\n  return a + b;\n}\n");
    const { baseGraph, graph, comparison } = readableComparison(files, changed);
    const line = whyLine(fileWhy("file:lib.ts" as NodeId, comparison, baseGraph, graph, (path) => path.endsWith(".test.ts"))!);
    expect(line).not.toContain("no test reaches it");
    expect(line).toContain("test reach unknown");
  });

  test("a broken file identical on both sides is still listed, as both", () => {
    const same = base({ "entry.ts": "export const e = 1;\n", "broken.ts": "export const b = (;\n" });
    expect(readableComparison(same, new Map(same)).comparison.unread).toEqual([{ path: "broken.ts", side: "both" }]);
  });

  test("the legend does not say no resource is reached, or that no file has dependents, when files could not be read", () => {
    const files = base({ "entry.ts": "export const e = 1;\n", "broken.ts": "export const b = (;\n" });
    const graph = extract(files);
    const town = townOf(graph, SPRITES, null, waysIn(files, graph));
    expect(harbourText(town)).toBe("harbour: no outside resource is reached in the files that could be read; 1 file could not be read");
    expect(plinthText(town)).toContain("1 file could not be read");
    const clean = townOf(extract(base({ "entry.ts": "export const e = 1;\n" })), SPRITES);
    expect(harbourText(clean)).toBe("harbour: no outside resource is reached");
  });

  test("an unread file's block list says not read, never none", () => {
    const files = new Map([["package.json", "{}\n"], ["a.ts", "export function f() {\n  return 1;\n}\n"]]);
    const broken = new Map(files).set("a.ts", "export function f() {\n  return 1;\n");
    const { baseGraph, graph, comparison } = readableComparison(files, broken);
    const found = fileWhy("file:a.ts" as NodeId, comparison, baseGraph, graph, () => false)!;
    expect(definingHeading(found)).toBe("Defining blocks: not read");
  });
});
