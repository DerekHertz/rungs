import { expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { risksOf } from "../src/risks.ts";
import { testChanges } from "../src/test-changes.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));

function risks(base: Record<string, string>, head: Record<string, string>) {
  const baseTree = tree(base);
  const headTree = tree(head);
  const baseGraph = extract(baseTree);
  const headGraph = extract(headTree);
  const comparison = compare(baseGraph, headGraph, { base: baseTree, head: headTree });
  return risksOf(comparison, baseGraph, headGraph, testChanges(baseTree, headTree));
}

const exp = (name: string, params = ""): string => `export function ${name}(${params}) {\n  return 1;\n}\n`;
const user = (from: string, name: string): string => `import { ${name} } from "${from}";\nexport const use = ${name};\n`;

const base = {
  "package.json": '{"dependencies":{"left":"1.0.0"}}\n',
  "src/core.ts": exp("core", "a") + exp("other"),
  "src/leaf.ts": exp("leaf", "a"),
  "src/mid.ts": user("./core.ts", "core"),
  "src/top.ts": user("./mid.ts", "use"),
  "src/top2.ts": user("./core.ts", "core"),
  "test/a.test.ts": 'import test from "node:test";\ntest("x", () => {});\ntest("y", () => {});\n',
};

test("a moved contract carries the files resting on its file, directly or not, and ranks by them", () => {
  const found = risks(base, { ...base, "src/core.ts": exp("core", "a, b") + exp("other"), "src/leaf.ts": exp("leaf", "a, b") });
  const contracts = found.filter((item) => item.kind === "contract");
  expect(contracts.map((item) => item.label)).toEqual(["core signature changed", "leaf signature changed"]);
  expect(contracts[0]!.blast).toEqual({ count: 3, files: ["src/mid.ts", "src/top.ts", "src/top2.ts"] });
  expect(contracts[0]!.ids).toEqual(["function:src/core.ts#core"]);
  expect(contracts[1]!.blast.count).toBe(0);
});

test("an added export is not a risk", () => {
  const found = risks(base, { ...base, "src/z.ts": exp("zed"), "src/core.ts": exp("core", "a") + exp("other") + exp("more") });
  expect(found).toEqual([]);
});

test("new effects reaching a process, the file system or the network are grouped by target; timers are not risks", () => {
  const found = risks(base, {
    ...base,
    "src/core.ts": `import { execFileSync } from "node:child_process";\nimport { readFileSync } from "node:fs";\n${exp("core", "a")}${exp("other")}export function run() {\n  execFileSync("git", ["log"]);\n  readFileSync("x.txt");\n  setTimeout(() => {}, 1);\n}\n`,
  });
  const effects = found.filter((item) => item.kind === "effect");
  expect(effects.map((item) => item.label).sort()).toEqual(['new file system call "x.txt"', 'new process call "git"']);
  expect(effects[0]!.blast.count).toBe(3);
  expect(effects[0]!.ids).toEqual(["function:src/core.ts#run"]);
});

test("removed tests, markers and edits of a base test file are risks; dependency changes come last", () => {
  const found = risks(base, {
    ...base,
    "package.json": '{"dependencies":{"left":"2.0.0","right":"1.0.0"}}\n',
    "test/a.test.ts": 'import test from "node:test";\ntest.skip("x", () => {});\n',
  });
  expect(found.map((item) => `${item.kind}: ${item.label}`)).toEqual([
    "test: test/a.test.ts edited",
    "test: x now skip",
    "test: y removed",
    "dependency: left changed",
    "dependency: right added",
  ]);
  expect(found[2]!.ids).toEqual(["file:test/a.test.ts"]);
  expect(found.at(-1)!.ids).toEqual(["file:package.json"]);
});

test("a removed file's contract takes its dependents from the base", () => {
  const rest: Record<string, string> = { ...base };
  delete rest["src/core.ts"];
  const core = risks(base, rest).find((item) => item.label === "core removed")!;
  expect(core.blast.files).toEqual(["src/mid.ts", "src/top.ts", "src/top2.ts"]);
});
