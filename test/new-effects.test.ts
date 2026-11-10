import { expect, test } from "vitest";
import { compare, pictureOf } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { effectChip, newEffects } from "../src/review.ts";
import type { EffectGroup, EffectsBlock } from "../src/review.ts";

const IMPORTS = 'import { spawn } from "node:child_process";\nimport fs from "node:fs";\n';
const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));

function effects(head: Record<string, string>, description: string, linked: readonly string[] = [], base: Record<string, string> = { "package.json": "{}\n" }) {
  const headGraph = extract(tree(head));
  const comparison = compare(extract(tree(base)), headGraph);
  return newEffects(comparison, pictureOf(headGraph, comparison).graph, description, new Set(linked as NodeId[]));
}

const shown = (groups: readonly EffectGroup[]): string[] =>
  groups.map((group) => {
    const target = typeof group.target === "string" ? group.target : JSON.stringify(group.target.literal);
    return `${group.resource} ${target}: ${group.rows.map((row) => `${row.label} ${row.operation} ${row.path}:${row.range.start}`).join(", ")}`;
  });

const FILES = {
  "package.json": "{}\n",
  "src/b.mjs": `${IMPORTS}export function build() {\n  spawn("tar");\n  fs.writeFileSync(p, d);\n  spawn("git");\n  fs.readFileSync("x.txt");\n  setTimeout(f, 1);\n}\n`,
  "src/a.mjs": `${IMPORTS}export function ship() {\n  spawn("git");\n  fetch(url);\n}\n`,
};

test("groups by resource then target, literals alphabetically, then unknown, then none, rows by path and line", () => {
  const { none } = effects(FILES, "Tidies.");
  expect(shown(none.groups)).toEqual([
    'process "git": ship child_process spawn src/a.mjs:4, build child_process spawn src/b.mjs:6',
    'process "tar": build child_process spawn src/b.mjs:4',
    "network unknown: ship fetch src/a.mjs:5",
    'file system "x.txt": build fs readFileSync src/b.mjs:7',
    "file system unknown: build fs writeFileSync src/b.mjs:5",
    "timer none: build setTimeout src/b.mjs:8",
  ]);
  expect(none).toMatchObject({ edges: 7, functions: 2 });
});

test("a module whose path or name the description gives is not listed, nor is a call whose literal target it names", () => {
  expect(shown(effects(FILES, "Edits src/a.mjs.").none.groups).join("\n")).not.toContain("ship");
  expect(shown(effects(FILES, "Changes `build`.").none.groups).join("\n")).not.toContain("build");
  const named = effects(FILES, "Shells out to tar.").none;
  expect(shown(named.groups).join("\n")).not.toContain('"tar"');
  expect(named.edges).toBe(6);
});

test("an agent link to the module, or to its file, moves the calls to the linked block", () => {
  const byFunction = effects(FILES, "Tidies.", ["function:src/a.mjs#ship"]);
  expect(byFunction.byAgent.edges).toBe(2);
  expect(byFunction.none.edges).toBe(5);
  const byFile = effects(FILES, "Tidies.", ["file:src/b.mjs"]);
  expect(byFile.byAgent.edges).toBe(5);
  expect(shown(byFile.byAgent.groups)[0]).toBe('process "git": build child_process spawn src/b.mjs:6');
});

test("calls in tests fold apart and calls in generated files are left out", () => {
  const head = {
    "package.json": "{}\n",
    "src/a.mjs": `${IMPORTS}export function ship() {\n  spawn("git");\n}\n`,
    "test/a.test.mjs": `${IMPORTS}export function check() {\n  spawn("git");\n  fs.rmSync(d);\n}\n`,
    "vendor/lib.js": `const fs = require("fs");\nfs.readFileSync("v");\n`,
  };
  const { none } = effects(head, "");
  expect(none).toMatchObject({ edges: 1, functions: 1 });
  expect(none.tests.edges).toBe(2);
  expect(shown(none.tests.groups)).toEqual(['process "git": check child_process spawn test/a.test.mjs:4', "file system unknown: check fs rmSync test/a.test.mjs:5"]);
  expect(JSON.stringify(none)).not.toContain("vendor");
});

test("a top-level call is owned by its file, and an edge that already existed is not new", () => {
  const head = { "package.json": "{}\n", "run.mjs": `${IMPORTS}spawn("git");\n`, "old.mjs": `${IMPORTS}export function f() {\n  spawn("kept");\n}\n` };
  const base = { "package.json": "{}\n", "old.mjs": `${IMPORTS}export function f() {\n  spawn("kept");\n}\n// touched\n` };
  const result: EffectsBlock = effects(head, "", [], base).none;
  expect(shown(result.groups)).toEqual(['process "git": run.mjs child_process spawn run.mjs:3']);
});

test("a chip names the resource and what it reached", () => {
  expect(effectChip('process child_process execFileSync "git"')).toBe("process git");
  expect(effectChip("network fetch (target unknown)")).toBe("network fetch");
  expect(effectChip("timer setTimeout")).toBe("timer setTimeout");
  expect(effectChip('file system fs/promises writeFile "a b.txt"')).toBe("file system a b.txt");
  expect(effectChip('network http createServer')).toBe("network createServer");
});

test("a call with an empty literal target is not covered by any description", () => {
  const base = { "package.json": "{}\n", "a.mjs": "export function f() {}\n" };
  const head = { "package.json": "{}\n", "a.mjs": 'export function f() {\n  fetch("");\n}\n' };
  const { none } = effects(head, "", [], base);
  expect(none.edges).toBe(1);
  expect(effects(head, "Edits things.", [], base).none.edges).toBe(1);
});
