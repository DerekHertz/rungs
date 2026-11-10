import { expect, test } from "vitest";
import { compare, contractsMoved, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { NOT_RUN, stopFacts } from "../src/stops.ts";
import type { Stop } from "../src/tour.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const imports = 'import { execFileSync } from "node:child_process";\nimport { readFileSync } from "node:fs";\n';
const exportsOf = (names: string[]): string => names.map((name) => `export function ${name}() {\n  return 1;\n}\n`).join("");
const baseGraph = extract(
  tree({
    "package.json": "{}\n",
    "src/api.ts": "export function load(path: string) {\n  return path;\n}\n\nexport function drop() {\n  return 1;\n}\n",
    "src/other.ts": "export function other() {\n  return 1;\n}\n",
  }),
);
const headGraph = extract(
  tree({
    "package.json": "{}\n",
    "src/api.ts": "export function load(path: string, strict: boolean) {\n  return strict ? path : path;\n}\n",
    "src/git.ts": `${imports}export function head(dir: string) {\n  const read = () => readFileSync(dir);\n  execFileSync("git", ["status"]);\n  return execFileSync("git", ["rev-parse"], { cwd: dir });\n}\n\nexport function quiet() {\n  return 1;\n}\n`,
    "src/many.ts": exportsOf(["one", "two", "three", "four", "five"]),
    "src/other.ts": `${imports}export function other() {\n  return execFileSync("npm");\n}\n`,
  }),
);
const comparison = compare(baseGraph, headGraph);
const moves = contractsMoved(comparison, baseGraph, headGraph);
const graph = pictureOf(headGraph, comparison).graph;

const stop = (ids: string[], ...texts: string[]): Stop => ({
  title: "t",
  ids: ids as NodeId[],
  claims: [],
  sentences: texts.map((text) => ({ text, id: ids[0] as NodeId, range: { start: 1, end: 1 } })),
});
const facts = (ids: string[], ...texts: string[]) => stopFacts(stop(ids, ...texts), comparison, graph, moves);

test("a stop's effects are the new effect edges of its nodes and of the code inside them, and no one else's", () => {
  const found = facts(["function:src/git.ts#head"]);
  expect(found.effects.map((effect) => [effect.label, effect.owner, effect.range.start])).toEqual([
    ['process child_process execFileSync "git"', "function:src/git.ts#head", 5],
    ['process child_process execFileSync "git"', "function:src/git.ts#head", 6],
    ["file system fs readFileSync (target unknown)", "function:src/git.ts#head.read", 4],
  ]);
  expect(facts(["function:src/git.ts#quiet"]).effects).toEqual([]);
  expect(facts(["file:src/git.ts"]).effects.map((effect) => effect.at)).toEqual(["file:src/git.ts", "file:src/git.ts", "file:src/git.ts"]);
  expect(found.effects.map((effect) => effect.at)).toEqual(["function:src/git.ts#head", "function:src/git.ts#head", "function:src/git.ts#head"]);
});

test("a stop's contract moves are those of its nodes and of the code inside them", () => {
  expect(facts(["file:src/api.ts"]).moves.map((found) => [found.move.kind, found.label])).toEqual([
    ["removed", "drop"],
    ["changed", "load"],
  ]);
  expect(facts(["function:src/api.ts#load"]).moves.map((found) => found.label)).toEqual(["load"]);
  expect(facts(["function:src/git.ts#quiet"]).moves.map((found) => found.move.kind)).toEqual(["added"]);
});

test("an effect the narration never names is noted once per resource and target, with its count", () => {
  expect(facts(["function:src/git.ts#head"], "Reads the current commit.").notes).toEqual([
    "agent did not mention: process git (2 calls)",
    "agent did not mention: file system readFileSync",
    "agent did not mention: contract added head",
  ]);
});

test("an effect counts as mentioned when a sentence names its literal target or its API, in any case", () => {
  expect(facts(["function:src/git.ts#head"], "The head function shells out to Git.", "It reads the directory with readFileSync.").notes).toEqual([]);
  expect(facts(["function:src/git.ts#head"], "head calls execFileSync twice.").notes).toEqual(["agent did not mention: file system readFileSync"]);
  expect(facts(["function:src/git.ts#head"], "head gets legit digits and a readFileSyncs.").notes).toEqual([
    "agent did not mention: process git (2 calls)",
    "agent did not mention: file system readFileSync",
  ]);
});

test("a contract move counts as mentioned when a sentence names the class or function", () => {
  expect(facts(["file:src/api.ts"], "load now takes a strict flag.").notes).toEqual(["agent did not mention: contract removed drop"]);
  expect(facts(["file:src/api.ts"], "This file loads things.").notes).toEqual([
    "agent did not mention: contract removed drop",
    "agent did not mention: contract changed load",
  ]);
  expect(facts(["file:src/other.ts"], "Runs something.").notes).toEqual(["agent did not mention: process npm", "agent did not mention: contract effects other"]);
  expect(facts(["file:src/other.ts"], "Runs npm.").notes).toEqual([]);
  expect(facts(["file:src/other.ts"], "other gained a call.").notes).toEqual(["agent did not mention: process npm"]);
});

test("more than three unnamed added exports are one note, so a new file does not bury the rest", () => {
  expect(facts(["file:src/many.ts"], "Adds one.").notes).toEqual(["agent did not mention: 4 added exports"]);
  expect(facts(["file:src/many.ts"], "Adds one and two.").notes).toEqual([
    "agent did not mention: contract added five",
    "agent did not mention: contract added four",
    "agent did not mention: contract added three",
  ]);
});

test("what was observed at a stop is not run until something records it", () => {
  expect(NOT_RUN).toEqual({ status: "not run" });
});
