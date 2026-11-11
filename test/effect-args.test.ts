import { describe, expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { changeText } from "../src/effects.ts";
import { extract } from "../src/extract/extract.ts";
import { argText } from "../src/graph.ts";

const graphOf = (source: string, path = "a.mjs") => extract(new Map([[path, source]]));

/** The effect call's arguments as text, for the first effect edge of one file. */
const argsOf = (source: string): string[] => (graphOf(source).edges[0]?.args ?? []).map(argText);

const changes = (base: string, head: string): string[] =>
  compare(graphOf(base), graphOf(head)).changedEffects.map((c) => `${c.owner.slice(c.owner.indexOf("#") + 1)} | ${c.label} | ${changeText(c)} | x${c.count}`);

const GIT = 'import { execFileSync } from "node:child_process";\n';

describe("effect call arguments", () => {
  test("an inline literal array is read as a list", () => {
    expect(argsOf(`${GIT}function f() { execFileSync("git", ["status", "-s"]); }`)).toEqual(['"git"', '["status", "-s"]']);
  });

  test("a spread of a module-level const array is read through, in place", () => {
    const source = `${GIT}const FLAGS = ["-c", "core.fsmonitor="];\nfunction f(a) { execFileSync("git", [...FLAGS, ...a, "log"]); }`;
    expect(argsOf(source)).toEqual(['"git"', '["-c", "core.fsmonitor=", ?a, "log"]']);
  });

  test("an argument that is not known is recorded as written, never guessed", () => {
    expect(argsOf(`${GIT}function f(cmd, o) { execFileSync(cmd, { cwd: o.dir }); }`)).toEqual(["?cmd", "?{ cwd: o.dir }"]);
  });

  test("a spread of a let, a parameter or an imported array stays unknown", () => {
    const source = `${GIT}let FLAGS = ["-c"];\nfunction f(P) { execFileSync("git", [...FLAGS, ...P]); }`;
    expect(argsOf(source)).toEqual(['"git"', "[?FLAGS, ?P]"]);
  });
});

describe("changed effects", () => {
  test("flags added to a git call through a spread const array", () => {
    const base = `${GIT}function run(a) { return execFileSync("git", a); }`;
    const head = `${GIT}const SAFE = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"];\nfunction run(a) { return execFileSync("git", [...SAFE, ...a]); }`;
    expect(changes(base, head)).toEqual([
      'run | process child_process execFileSync "git" | +"-c" +"core.fsmonitor=" +"-c" +"core.hooksPath=/dev/null" | x1',
    ]);
  });

  test("flags added inline", () => {
    const base = `${GIT}function run() { execFileSync("git", ["status"]); }`;
    const head = `${GIT}function run() { execFileSync("git", ["status", "--short"]); }`;
    expect(changes(base, head)).toEqual(['run | process child_process execFileSync "git" | +"--short" | x1']);
  });

  test("an argument that stays unknown is no change, and one written another way is", () => {
    const base = `${GIT}function run(a, b) { execFileSync("git", a); }`;
    expect(changes(base, `${GIT}function run(a, b) { execFileSync("git", a); }\n`)).toEqual([]);
    expect(changes(base, `${GIT}function run(a, b) { execFileSync("git", b); }`)).toEqual(['run | process child_process execFileSync "git" | +?b -?a | x1']);
  });

  test("identical changes at several calls in one function are one entry with a count", () => {
    const base = `${GIT}function run() { execFileSync("git", ["a"]); execFileSync("git", ["b"]); }`;
    const head = `${GIT}function run() { execFileSync("git", ["a", "-q"]); execFileSync("git", ["b", "-q"]); }`;
    expect(changes(base, head)).toEqual(['run | process child_process execFileSync "git" | +"-q" | x2']);
  });

  test("a changed target is a new edge, not a changed effect", () => {
    const base = `${GIT}function run() { execFileSync("git", ["a"]); }`;
    const head = `${GIT}function run() { execFileSync("hg", ["a"]); }`;
    expect(changes(base, head)).toEqual([]);
  });

  test("no change", () => {
    const source = `${GIT}function run() { execFileSync("git", ["a", "b"]); }`;
    expect(changes(source, source)).toEqual([]);
  });
});

describe("module resolution", () => {
  const REQ = 'import { createRequire } from "node:module";\n';

  test("createRequire moved to another base", () => {
    const base = `${REQ}function load(base) { return createRequire(base)("playwright"); }`;
    const head = `${REQ}function load() { return createRequire(join(ROOT, "package.json"))("playwright"); }`;
    expect(changes(base, head)).toEqual(['load | module createRequire | +?join(ROOT, "package.json") -?base | x1']);
  });

  test("a literal base changed", () => {
    const base = `${REQ}function load() { return createRequire("/a/package.json"); }`;
    const head = `${REQ}function load() { return createRequire("/b/package.json"); }`;
    expect(changes(base, head)).toEqual(['load | module createRequire | +"/b/package.json" -"/a/package.json" | x1']);
  });

  test("require.resolve and dynamic import with a changed specifier", () => {
    expect(changes('function f() { return require.resolve("a"); }', 'function f() { return require.resolve("b"); }')).toEqual([
      'f | require.resolve | +"b" -"a" | x1',
    ]);
    expect(changes('async function f() { await import("a"); }', 'async function f() { await import("b"); }')).toEqual([
      'f | import() | +"b" -"a" | x1',
    ]);
  });

  test("a new resolution is reported with its arguments; an unchanged one is not", () => {
    const base = "async function f() { await import(\"a\"); }";
    expect(changes(base, base)).toEqual([]);
    expect(changes("async function f() {}", base)).toEqual(['f | import() | +"a" | x1']);
  });

  test("a local createRequire or require is not a resolution", () => {
    expect(graphOf("function createRequire(x) {}\nfunction f() { createRequire('a'); }").resolutions).toEqual([]);
    expect(graphOf("function f(require) { require.resolve('a'); }").resolutions).toEqual([]);
  });
});
