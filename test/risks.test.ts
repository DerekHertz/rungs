import { expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree } from "../src/graph.ts";
import { risksOf } from "../src/risks.ts";
import { isTestFile } from "../src/test-files.ts";
import { testChanges } from "../src/test-changes.ts";

const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));

function risks(base: Record<string, string>, head: Record<string, string>) {
  const baseTree = tree(base);
  const headTree = tree(head);
  const baseGraph = extract(baseTree);
  const headGraph = extract(headTree);
  const comparison = compare(baseGraph, headGraph, { base: baseTree, head: headTree });
  return risksOf(comparison, baseGraph, headGraph, testChanges(baseTree, headTree), isTestFile);
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

const exec = 'import { execSync } from "node:child_process";\nexport function go() {\n  execSync("git status");\n}\n';

test("effects in test and generated files are kept, ranked after the rest of their kind", () => {
  const found = risks({ "package.json": "{}\n" }, { "package.json": "{}\n", "test/a.test.js": exec, "a.min.js": exec, "src/s.js": exec });
  const effects = found.filter((item) => item.kind === "effect");
  expect(effects.map((item) => `${item.path} ${item.demoted === true}`)).toEqual(["src/s.js false", "a.min.js true"]);
  expect(effects[1]!.detail).toContain("test/a.test.js");
});

test("a moved file keeps the dependents it had in the base", () => {
  const b = { "package.json": "{}\n", "a.ts": exp("f"), "b.ts": user("./a.ts", "f") };
  const found = risks(b, { "package.json": "{}\n", "b.ts": b["b.ts"], "new.ts": b["a.ts"] });
  expect(found.find((item) => item.label === "f moved")!.blast.files).toEqual(["b.ts"]);
});

test("files that depend on each other count one another in a grouped effect", () => {
  const call = (from: string): string => `import "${from}";\nexport async function x() {\n  await fetch("https://e.com");\n}\n`;
  const found = risks(
    { "package.json": "{}\n", "a.ts": 'import "./b.ts";\nexport const a = 1;\n', "b.ts": 'import "./a.ts";\nexport const b = 1;\n' },
    { "package.json": "{}\n", "a.ts": call("./b.ts"), "b.ts": call("./a.ts") },
  );
  expect(found.find((item) => item.kind === "effect")!.blast.files).toEqual(["a.ts", "b.ts"]);
});

const typesFile = "export interface Config {\n  port: number;\n}\n";
const client = 'import type { Config } from "./types.ts";\nexport const c: Config | undefined = undefined;\n';

test("a moved file that the base imported is a risk even when no contract changed", () => {
  const found = risks({ "package.json": "{}\n", "types.ts": typesFile, "client.ts": client }, { "package.json": "{}\n", "new.ts": typesFile, "client.ts": client });
  expect(found.map((item) => item.label)).toEqual(["new.ts moved: 1 file still imports the old path types.ts"]);
  expect(found[0]!.blast.files).toEqual(["client.ts"]);
  expect(found[0]!.ids).toEqual(["file:new.ts"]);
});

test("a removed file that the base imported is a risk in its own right", () => {
  const found = risks({ "package.json": "{}\n", "types.ts": typesFile, "client.ts": client }, { "package.json": "{}\n", "client.ts": client });
  expect(found.map((item) => item.label)).toContain("types.ts removed: 1 file still imports it");
});

test("changed effects group by resource and target like new ones", () => {
  const write = (arg: string): string => `import { writeFileSync } from "node:fs";\nexport function w() {\n  writeFileSync("data", ${arg});\n}\n`;
  const b = { "package.json": "{}\n", "a.ts": write('"1"'), "b.ts": write('"1"'), "x.ts": 'import "./a.ts";\nexport const x = 1;\n', "y.ts": 'import "./b.ts";\nexport const y = 1;\n' };
  const found = risks(b, { ...b, "a.ts": write('"2"'), "b.ts": write('"2"') }).filter((item) => item.kind === "effect");
  expect(found).toHaveLength(1);
  expect(found[0]!.blast.files).toEqual(["x.ts", "y.ts"]);
  expect(found[0]!.ids).toEqual(["function:a.ts#w", "function:b.ts#w"]);
});

test("an effect is demoted when the test predicate says its file is a test, whatever the graph role", () => {
  const call = 'export async function f() {\n  await fetch("https://e.com");\n}\n';
  const found = risks({ "package.json": "{}\n" }, { "package.json": "{}\n", "a-test.js": call, "z.js": call }).filter((item) => item.kind === "effect");
  expect(found.map((item) => `${item.path} ${item.demoted === true}`)).toEqual(["z.js false", "a-test.js true"]);
});

test("an edited base file the runner counts as a test is listed even when its role is source", () => {
  const b = { "package.json": "{}\n", "smoke-test.js": "export const a = 1;\n" };
  const found = risks(b, { ...b, "smoke-test.js": "export const a = 2;\n" });
  expect(found.map((item) => item.label)).toContain("smoke-test.js edited");
});
