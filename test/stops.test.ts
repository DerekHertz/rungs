import { expect, test } from "vitest";
import { compare, contractsMoved, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { NOT_RUN, coverageLine, stopFacts, tourCoverage, walkSummary } from "../src/stops.ts";
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

const factsOf = (before: Record<string, string>, after: Record<string, string>, ids: string[], ...texts: string[]) => {
  const was = extract(tree({ "package.json": "{}\n", ...before }));
  const now = extract(tree({ "package.json": "{}\n", ...after }));
  const diff = compare(was, now);
  return stopFacts(stop(ids, ...texts), diff, pictureOf(now, diff).graph, contractsMoved(diff, was, now));
};

test("an effect a stop's code no longer makes is a fact there, and is noted unless a sentence names the effect itself", () => {
  const before = { "src/send.ts": 'export function send() {\n  fetch("https://audit.example");\n}\n' };
  const after = { "src/send.ts": "export function send() {}\n" };
  const found = factsOf(before, after, ["function:src/send.ts#send"], "Updates send.");
  expect(found.effects.map((effect) => [effect.kind, effect.label, effect.at, effect.mentioned])).toEqual([
    ["removed", 'network fetch "https://audit.example"', "function:src/send.ts#send", false],
  ]);
  expect(found.moves.map((entry) => [entry.move.kind, entry.move.effects])).toEqual([["effects", { added: [], removed: ['network fetch "https://audit.example"'] }]]);
  expect(found.notes).toEqual(["agent did not mention: removed network https://audit.example"]);
  expect(factsOf(before, after, ["file:src/send.ts"], "send no longer calls fetch.").notes).toEqual([]);
  expect(factsOf(before, after, ["file:src/send.ts"], "Tidies the file.").notes).toEqual([
    "agent did not mention: removed network https://audit.example",
    "agent did not mention: contract effects send",
  ]);
});

test("an effect removed with the function that made it is a fact at a stop on that function or its file", () => {
  const before = { "src/send.ts": 'export function send() {\n  fetch("https://audit.example");\n}\nexport function keep() {}\n' };
  const after = { "src/send.ts": "export function keep() {}\n" };
  expect(factsOf(before, after, ["file:src/send.ts"], "Drops send.").notes).toEqual(["agent did not mention: removed network https://audit.example"]);
  expect(factsOf(before, after, ["function:src/send.ts#send"], "Drops send.").effects.map((effect) => effect.kind)).toEqual(["removed"]);
  expect(factsOf(before, after, ["function:src/send.ts#keep"], "Keeps keep.").effects).toEqual([]);
});

test("unnamed effects in test files are one note for the stop, however many files and calls", () => {
  const imports = 'import { mkdirSync, rmSync } from "node:fs";\n';
  const body = `${imports}mkdirSync("tmp");\nrmSync("tmp");\n`;
  const after = { "test/a.test.ts": body, "test/b.test.ts": body, "src/run.ts": `${imports}export function run() {\n  mkdirSync("out");\n}\n` };
  const ids = ["file:test/a.test.ts", "file:test/b.test.ts", "function:src/run.ts#run"];
  expect(factsOf({}, after, ids, "Adds run and its tests.").notes).toEqual([
    "agent did not mention: file system out",
    "agent did not mention: 4 effect edges changed in 2 test files",
  ]);
  expect(factsOf({}, after, ids, "run makes out; the tests use mkdirSync.").notes).toEqual(["agent did not mention: 2 effect edges changed in 2 test files"]);
  expect(factsOf({}, after, ["file:test/a.test.ts"], "Uses mkdirSync.").notes).toEqual(["agent did not mention: 1 effect edge changed in 1 test file"]);
  expect(factsOf({}, after, ["file:test/a.test.ts"], "Tests.").effects).toHaveLength(2);
});

test("the tour covers the changed files its stops point into, and no others", () => {
  const first = stop(["function:src/git.ts#head", "file:src/api.ts"]);
  const second = stop(["file:src/api.ts", "file:src/nowhere.ts"]);
  expect(tourCoverage([first, second], comparison)).toEqual({ covered: 2, changed: 4 });
  expect(tourCoverage([], comparison)).toEqual({ covered: 0, changed: 4 });
});

test("the walkthrough's one line says how the tour was made and what was dropped, or why there is none", () => {
  const dropped = { stops: 1, ids: 2, claims: 0, sentences: 3 };
  expect(walkSummary({ status: "ok", model: "m", promptVersion: "tour-v1", dropped, cached: false }, 12)).toBe(
    "12 stops by m (prompt tour-v1); dropped 1 stops, 2 unknown ids, 0 bad claim numbers and 3 unanchored sentences, not shown.",
  );
  expect(walkSummary({ status: "ok", model: "m", promptVersion: "tour-v1", dropped, cached: true }, 1)).toMatch(/^1 stop by m, cached \(/);
  expect(walkSummary({ status: "failed", message: "claude CLI not found (claude)" }, 0)).toBe("No walkthrough: claude CLI not found (claude).");
  expect(walkSummary({ status: "off" }, 0)).toBe("No walkthrough; run with --walkthrough for an agent's tour of the change.");
});

test("the coverage line says how many changed files the tour covers, so a partial tour is not read as the whole change", () => {
  expect(coverageLine({ covered: 51, changed: 144 })).toBe("The tour covers 51 of 144 changed files.");
  expect(coverageLine({ covered: 1, changed: 1 })).toBe("The tour covers 1 of 1 changed file.");
});
