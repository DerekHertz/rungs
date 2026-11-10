import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extract } from "../src/extract/extract.ts";
import { isCodeNode, nodeId } from "../src/graph.ts";
import type { FileTree } from "../src/graph.ts";
import { pseudocode, renderPseudocode } from "../src/pseudocode.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const fixture = fileURLToPath(new URL("fixtures/pseudocode", import.meta.url));
const goldenPath = fileURLToPath(new URL("golden/pseudocode.txt", import.meta.url));

const tree = readFixtureTree(fixture);
const graph = extract(tree);

function outline(name: string, files: FileTree = tree): string {
  const id = nodeId("function", "everything.js", name);
  const lines = pseudocode(extract(files), files, id);
  if (lines === undefined) throw new Error(`no pseudocode for ${name}`);
  return renderPseudocode(lines);
}

describe("pseudocode of a function", () => {
  test("every control structure of the fixture matches the committed golden (UPDATE_GOLDEN=1 rewrites it)", () => {
    const names = graph.nodes.filter(isCodeNode).filter((node) => node.level === "function" && node.path === "everything.js" && !node.qualifiedName.includes("."));
    const text = names.map((node) => `== ${node.qualifiedName}\n${outline(node.qualifiedName)}`).join("\n");
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenPath, text);
    expect(text).toBe(readFileSync(goldenPath, "utf8"));
  });

  test("straight-line code collapses with its line count, a comment between statements stays out", () => {
    expect(outline("straight")).toBe("L60-61   2 lines of straight-line code\nL63      return d;\n");
  });

  test("an expression-bodied arrow function is one line", () => {
    expect(outline("short")).toBe("L57      => a + 1\n");
  });

  test("an effect in a parameter default is listed", () => {
    expect(outline("paramEffect")).toBe('L66      effect file system: fs readFileSync "default.txt"\nL67      return path;\n');
  });

  test("conditions are exactly as written, however they were laid out", () => {
    const files: FileTree = new Map([
      ["everything.js", 'export function f(a, b) {\n  if (\n    a   &&\n    b.c(\n      "x"\n    )\n  ) return 1;\n}\n'],
    ]);
    expect(outline("f", files)).toBe('L2-7     if ( a && b.c( "x" ) )\nL7         return 1;\n');
  });

  test("the same function renders the same pseudocode", () => {
    expect(outline("everything")).toBe(outline("everything"));
  });

  test("a nested function is one line pointing at its own node", () => {
    const lines = pseudocode(graph, tree, nodeId("function", "everything.js", "everything"))!;
    const nested = lines.filter((line) => line.kind === "function");
    expect(nested.map((line) => [line.text, line.node])).toEqual([
      ["function helper", nodeId("function", "everything.js", "everything.helper")],
      ["function map() callback", nodeId("function", "everything.js", 'everything."map() callback"')],
    ]);
  });

  test("an effect line is the graph's effect edge, not a guess", () => {
    const lines = pseudocode(graph, tree, nodeId("function", "everything.js", "everything"))!;
    const effects = lines.filter((line) => line.kind === "effect").map((line) => line.text);
    expect(effects).toEqual([
      'effect file system: fs readFileSync "config.json"',
      'effect process: child_process execFileSync "git"',
      'await effect network: fetch "https://example.test/api"',
    ]);
  });

  test("classes, files and unknown ids have no pseudocode", () => {
    expect(pseudocode(graph, tree, nodeId("file", "everything.js", ""))).toBeUndefined();
    expect(pseudocode(graph, tree, nodeId("function", "everything.js", "nope"))).toBeUndefined();
  });
});

describe("review round 1", () => {
  const of = (source: string) => outline("f", new Map([["everything.js", source]]));

  test("an effect attaches to its own call, not to another call on the same line", () => {
    expect(of('async function f() {\n await noop(); fetch("x");\n}\n')).toBe('L2       await noop()\nL2       effect network: fetch "x"\n');
  });

  test("a with statement shows its control flow", () => {
    expect(of("function f(obj) {\n with (obj) {\n if (bad) throw 1;\n return ok;\n }\n}\n")).toBe(
      "L2       with (obj)\nL3         if (bad)\nL3           throw 1;\nL4         return ok;\n",
    );
  });

  test("whitespace inside string and template literals is kept", () => {
    expect(of('function f(x) {\n if (x === "a  b" || x === `c   ${x}  d`) return 1;\n}\n')).toBe(
      'L2       if (x === "a  b" || x === `c   ${x}  d`)\nL2         return 1;\n',
    );
  });

  test("identical nested functions keep their own pointers, in source order", () => {
    const files: FileTree = new Map([["everything.js", "function f() {\n const z = () => 0;\n const a = () => 0;\n}\n"]]);
    const lines = pseudocode(extract(files), files, nodeId("function", "everything.js", "f"))!;
    expect(lines.map((line) => [line.range.start, line.text, line.node])).toEqual([
      [2, "function z", nodeId("function", "everything.js", "f.z")],
      [3, "function a", nodeId("function", "everything.js", "f.a")],
    ]);
  });

  test("a line's range spans the whole construct it shows", () => {
    expect(of('async function f() {\n await\n fetch("x");\n}\n')).toBe('L2-3     await effect network: fetch "x"\n');
    expect(of("function f(flag) {\n do {} while (\n flag\n );\n}\n")).toBe("L2       do\nL2-4     while (flag)\n");
  });
});
