import { describe, expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { changeText } from "../src/effects.ts";
import { extract } from "../src/extract/extract.ts";
import { argText } from "../src/graph.ts";

const graphOf = (source: string, path = "a.mjs") => extract(new Map([[path, source]]));

const changes = (base: string, head: string, path = "a.mjs"): string[] =>
  compare(graphOf(base, path), graphOf(head, path)).changedEffects.map((c) => `${c.owner.slice(c.owner.indexOf("#") + 1)} | ${c.label} | ${changeText(c)} | x${c.count}`);

const addedArgs = (base: string, head: string, path = "a.mjs"): string[] =>
  compare(graphOf(base, path), graphOf(head, path))
    .effects.filter((c) => c.kind === "added")
    .map((c) => c.edge.args.map(argText).join());

const loadArgs = (source: string, path = "a.cjs"): string[] =>
  graphOf(source, path)
    .edges.filter((edge) => edge.to === "resource:code loaded at run time")
    .flatMap((edge) => edge.args.map(argText));

const GIT = 'import { execFileSync } from "node:child_process";\n';
const MADE = 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n';

describe("effect arguments, review round 2", () => {
  test("a list around an argument is not the argument, so the unchanged call pairs first", () => {
    expect(addedArgs("function f(x) { fetch(x); }", "function f(x) { fetch([x]); fetch(x); }")).toEqual(["[?x]"]);
    const base = `${GIT}function f(x) { execFileSync("git", x); }`;
    expect(addedArgs(base, `${GIT}function f(x) { execFileSync("git", [x]); execFileSync("git", x); }`)).toEqual(['"git",[?x]']);
  });

  test("the changed-effects report pairs the same way", () => {
    expect(changes("function f(x) { fetch(x); }", "function f(x) { fetch([x]); fetch(x); }")).toEqual([]);
  });

  test("a spread of a const array that holds a spread keeps the spread at the top level", () => {
    const base = "const a = process.argv;\nfunction f() { return require(a); }";
    const head = "const a = process.argv;\nconst A = [...a];\nfunction f() { return require(...A); }";
    expect(changes(base, head, "a.cjs")).toEqual(["f | code loaded at run time require (target unknown) | +?...a -?a | x1"]);
    expect(loadArgs(head)).toEqual(["?...a"]);
    expect(loadArgs("const a = process.argv;\nconst A = [...a];\nfunction f() { return require([...A]); }")).toEqual(["[?a]"]);
  });

  test("a call through a require made by createRequire is a load", () => {
    const base = `${MADE}function f(a, b) { return require(a); }`;
    expect(changes(base, base.replace("require(a)", "require(b)"))).toEqual(["f | code loaded at run time require (target unknown) | +?b -?a | x1"]);
    expect(loadArgs(base.replace("require(a)", "require('x')"), "a.mjs")).toEqual(["?import.meta.url"]);
    expect(graphOf(base.replace("require(a)", "require.resolve(a)")).resolutions.map((r) => r.operation)).toEqual(["require.resolve"]);
  });

  test("a require shadowed in another script is not the global one, even through a destructured createRequire", () => {
    const graph = extract(
      new Map([
        ["a.ts", "function require(x: string) { return { createRequire: (y: string) => y }; }"],
        ["b.ts", 'const { createRequire } = require("module");\ncreateRequire(n);'],
      ]),
    );
    expect(graph.edges).toEqual([]);
  });

  test("the global require still reaches createRequire through a destructuring", () => {
    expect(graphOf('const { createRequire } = require("module");\ncreateRequire(n);', "a.cjs").edges.map((e) => e.operation)).toEqual(["module createRequire"]);
  });
});
