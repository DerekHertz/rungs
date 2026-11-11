import { expect, test } from "vitest";
import { compare, contractsMoved, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { contractsReport, effectsChangedRows, newEffects, unmentioned, unmentionedIds } from "../src/review.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
const GIT = 'import { execFileSync } from "node:child_process";\n';
const base = { "package.json": "{}\n", "src/run.mjs": `${GIT}function inner(a) {\n  return execFileSync("git", a);\n}\nexport function run(a) {\n  return inner(a);\n}\n` };
const head = {
  "package.json": "{}\n",
  "src/run.mjs": `${GIT}const SAFE = ["-c", "core.fsmonitor="];\nfunction inner(a) {\n  return execFileSync("git", [...SAFE, ...a]);\n}\nexport function run(a) {\n  return inner(a);\n}\n`,
};

function analyse(description: string, linked: readonly string[] = []) {
  const headGraph = extract(tree(head));
  const baseGraph = extract(tree(base));
  const comparison = compare(baseGraph, headGraph);
  const picture = pictureOf(headGraph, comparison).graph;
  const claims = unmentioned(comparison, picture, description);
  const rows = effectsChangedRows(comparison, picture, description, new Set(linked as NodeId[]));
  return {
    rows,
    effects: newEffects(comparison, picture, description, new Set(linked as NodeId[])),
    report: contractsReport(comparison, contractsMoved(comparison, baseGraph, headGraph), unmentionedIds(claims), picture, rows),
    moves: contractsMoved(comparison, baseGraph, headGraph),
  };
}

test("a changed call under an unexported function is in Contracts moved, though no exported signature moved", () => {
  const { report, moves } = analyse("");
  expect(moves).toEqual([]);
  expect(report.effectsChanged.map((row) => [row.label, row.change.label, row.change.added, row.coverage])).toEqual([
    ["inner", 'process child_process execFileSync "git"', ['"-c"', '"core.fsmonitor="'], "none"],
  ]);
});

test("a description that names the function or the file covers it; one that names the flag does too", () => {
  expect(analyse("Hardens inner.").rows.map((row) => row.coverage)).toEqual(["claimed"]);
  expect(analyse("Touches src/run.mjs.").rows.map((row) => row.coverage)).toEqual(["claimed"]);
  expect(analyse('Adds "core.fsmonitor=" to git.').rows.map((row) => row.coverage)).toEqual(["claimed"]);
});

test("Unmentioned lists it only when no claim covers it, and an agent's link moves it to byAgent", () => {
  expect(analyse("Nothing relevant.").effects.changed.none).toHaveLength(1);
  const linked = analyse("Nothing relevant.", ["function:src/run.mjs#inner"]);
  expect(linked.effects.changed.none).toHaveLength(0);
  expect(linked.effects.changed.byAgent).toHaveLength(1);
  expect(analyse("Hardens inner.").effects.changed.none).toHaveLength(0);
});
