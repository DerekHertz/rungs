import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CallResolver } from "../src/calls.ts";
import { extract } from "../src/extract/extract.ts";
import type { FileTree, NodeId } from "../src/graph.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const fixture = fileURLToPath(new URL("fixtures/calls", import.meta.url));
const goldenPath = fileURLToPath(new URL("golden/calls.json", import.meta.url));

const over = (tree: FileTree): CallResolver => new CallResolver(tree, extract(tree));
const files = (record: Record<string, string>): FileTree => new Map(Object.entries({ "package.json": "{}\n", ...record }));
const id = (path: string, name: string): NodeId => `function:${path}#${name}` as NodeId;
const names = (refs: readonly { label: string }[]): string[] => refs.map((ref) => ref.label);

describe("call edges on the calls fixture", () => {
  const tree = readFixtureTree(fixture);
  const graph = extract(tree);
  const resolver = new CallResolver(tree, graph);

  test("matches the committed golden (UPDATE_GOLDEN=1 rewrites it)", () => {
    const blocks = graph.nodes.filter((node) => node.level === "function" || node.level === "class");
    const text = `${JSON.stringify(blocks.map((block) => ({ id: block.id, callers: resolver.callersOf(block.id), callees: resolver.calleesOf(block.id) })), null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenPath, text);
    expect(text).toBe(readFileSync(goldenPath, "utf8"));
  });

  test("a cross-file call through a re-export reaches the declaration, pinned to the call's line", () => {
    const callers = resolver.callersOf(id("src/util.ts", "greet"));
    expect(callers.map((ref) => [ref.label, ref.path, ref.at])).toEqual([
      ["main", "src/app.ts", [{ start: 14, end: 14 }]],
      ["twice", "src/util.ts", [{ start: 6, end: 6 }, { start: 6, end: 6 }]],
    ]);
  });

  test("a method called through a class instance, and the class made with new", () => {
    expect(names(resolver.callersOf(id("src/shapes.ts", "Counter.bump")))).toEqual(["main"]);
    expect(names(resolver.callersOf("class:src/shapes.ts#Counter" as NodeId))).toEqual(["main"]);
  });

  test("a default import resolves to the default export", () => {
    expect(names(resolver.callersOf(id("src/shout.ts", "shout")))).toEqual(["main"]);
  });

  test("a dynamic call, a call into node_modules and a built-in are unresolved, with their text", () => {
    const callees = resolver.calleesOf(id("src/app.ts", "main"));
    expect(callees.resolved.map((ref) => [ref.label, ref.path])).toEqual([
      ["Counter", "src/shapes.ts"],
      ["Counter.bump", "src/shapes.ts"],
      ["shout", "src/shout.ts"],
      ["greet", "src/util.ts"],
    ]);
    expect(callees.unresolved).toEqual([
      { text: "handlers[name]", at: { start: 11, end: 11 } },
      { text: "leftPad", at: { start: 12, end: 12 } },
      { text: "JSON.stringify", at: { start: 13, end: 13 } },
    ]);
  });
});

describe("the resolver", () => {
  test("a callee of a block inside a callback counts for the block, and the caller is the named holder", () => {
    const resolver = over(files({ "a.ts": "export function f() {\n  return 1;\n}\n", "b.ts": 'import { f } from "./a.ts";\nexport function g() {\n  [1].map(() => f());\n}\n' }));
    expect(names(resolver.callersOf(id("a.ts", "f")))).toEqual(["g"]);
    expect(names(resolver.calleesOf(id("b.ts", "g")).resolved)).toEqual(["f"]);
  });

  test("a call at module top level is made by the file", () => {
    const resolver = over(files({ "a.ts": "export function f() {}\n", "b.ts": 'import { f } from "./a.ts";\nf();\n' }));
    expect(resolver.callersOf(id("a.ts", "f"))).toEqual([{ id: "file:b.ts", label: "(top level)", level: "file", path: "b.ts", range: null, at: [{ start: 2, end: 2 }] }]);
  });

  test("a call through any, and a function declared only as an interface member, are unresolved", () => {
    const resolver = over(files({ "a.ts": "interface I {\n  run(): void;\n}\nexport function f(x: any, i: I) {\n  x.run();\n  i.run();\n}\n" }));
    expect(resolver.calleesOf(id("a.ts", "f"))).toEqual({
      resolved: [],
      unresolved: [
        { text: "x.run", at: { start: 5, end: 5 } },
        { text: "i.run", at: { start: 6, end: 6 } },
      ],
    });
  });

  test("recursion is neither a caller nor a callee of the block itself", () => {
    const resolver = over(files({ "a.ts": "export function f(n: number): number {\n  return n === 0 ? 0 : f(n - 1);\n}\n" }));
    expect(resolver.callersOf(id("a.ts", "f"))).toEqual([]);
    expect(resolver.calleesOf(id("a.ts", "f")).resolved).toEqual([]);
  });

  test("an effect is left to the effects, not listed as an unresolved call", () => {
    const resolver = over(files({ "a.ts": 'import { readFileSync } from "node:fs";\nexport function f() {\n  readFileSync("x");\n}\n' }));
    expect(resolver.calleesOf(id("a.ts", "f"))).toEqual({ resolved: [], unresolved: [] });
  });

  test("an arrow function bound to a name is that name's block, and a file that only re-exports is searched on", () => {
    const resolver = over(
      files({
        "a.ts": "export const f = () => 1;\n",
        "mid.ts": 'export * from "./a.ts";\n',
        "top.ts": 'import { f } from "./mid.ts";\nexport function g() {\n  return f();\n}\n',
      }),
    );
    expect(names(resolver.callersOf(id("a.ts", "f")))).toEqual(["g"]);
  });

  test("a CommonJS require resolves to the exported function", () => {
    const resolver = over(files({ "a.js": "function f() {\n  return 1;\n}\nmodule.exports = { f };\n", "b.js": 'const { f } = require("./a.js");\nfunction g() {\n  return f();\n}\nmodule.exports = g;\n' }));
    expect(names(resolver.calleesOf(id("b.js", "g")).resolved)).toEqual(["f"]);
  });

  test("an id that is not a class or function has no edges", () => {
    const resolver = over(files({ "a.ts": "export function f() {}\n" }));
    expect(resolver.has("file:a.ts" as NodeId)).toBe(false);
    expect(resolver.callersOf("file:a.ts" as NodeId)).toEqual([]);
    expect(resolver.calleesOf("nope" as NodeId)).toEqual({ resolved: [], unresolved: [] });
  });
});
