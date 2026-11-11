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

describe("review round 1: nothing is guessed, no caller is missed", () => {
  const callees = (record: Record<string, string>, path: string, name: string) => over(files(record)).calleesOf(id(path, name));
  const texts = (record: Record<string, string>, path: string, name: string): string[] => callees(record, path, name).unresolved.map((call) => call.text);

  test("1. a conditional, logical or comma callee is unresolved", () => {
    const record = { "a.ts": "function a() {}\nfunction b() {}\nexport function f(x: boolean) {\n  (x ? a : b)();\n  (x && a)();\n  (0, a)();\n}\n" };
    expect(callees(record, "a.ts", "f").resolved).toEqual([]);
    expect(texts(record, "a.ts", "f")).toHaveLength(3);
  });

  test("2. an element access is unresolved, named as written", () => {
    const record = { "a.ts": "const o = { run() {} };\nexport function f(key: string) {\n  o[key]();\n}\n" };
    expect(callees(record, "a.ts", "f").resolved).toEqual([]);
    expect(texts(record, "a.ts", "f")).toEqual(["o[key]"]);
  });

  test("3. a let or var binding, or a function assigned to elsewhere, is unresolved", () => {
    const record = { "a.ts": "export function f() {\n  let g = () => 1;\n  g = () => 2;\n  g();\n  var h = () => 1;\n  h();\n  k();\n}\nfunction k() {}\nk = () => 3;\n" };
    expect(callees(record, "a.ts", "f").resolved).toEqual([]);
    expect(texts(record, "a.ts", "f")).toEqual(["g", "h", "k"]);
  });

  test("4. a getter that returns the function is unresolved, not the getter", () => {
    const record = { "a.ts": "function real() {}\nconst o = {\n  get f() {\n    return real;\n  },\n};\nexport function g() {\n  o.f();\n}\n" };
    expect(callees(record, "a.ts", "g").resolved).toEqual([]);
    expect(texts(record, "a.ts", "g")).toEqual(["o.f"]);
  });

  test("5. an import and a re-export of the same name in one file: both are followed", () => {
    const resolver = over(
      files({
        "a.ts": "export function f() {}\n",
        "b.ts": 'import { f } from "./a.ts";\nexport { f } from "./a.ts";\nexport function inB() {\n  f();\n}\n',
        "c.ts": 'import { f } from "./b.ts";\nexport function inC() {\n  f();\n}\n',
      }),
    );
    expect(names(resolver.callersOf(id("a.ts", "f")))).toEqual(["inB", "inC"]);
  });

  test("6. an import then export barrel is followed", () => {
    const resolver = over(
      files({
        "a.ts": "export function f() {}\n",
        "b.ts": 'import { f } from "./a.ts";\nexport { f };\n',
        "c.ts": 'import { f } from "./b.ts";\nexport function inC() {\n  f();\n}\n',
      }),
    );
    expect(names(resolver.callersOf(id("a.ts", "f")))).toEqual(["inC"]);
  });

  test("8. an effect does not hide an unrelated unresolved call on its line", () => {
    const record = { "a.ts": 'import { readFileSync } from "node:fs";\nexport function f(u: any) {\n  readFileSync("x"); u();\n}\n' };
    expect(texts(record, "a.ts", "f")).toEqual(["u"]);
  });

  test("9. a local require is a call, not a module load", () => {
    const record = { "a.ts": 'function require(name: string) {\n  return name;\n}\nexport function f() {\n  require("x");\n}\n' };
    expect(callees(record, "a.ts", "f").resolved.map((ref) => ref.label)).toEqual(["require"]);
  });

  test("10. a call through an assertion or a value typed any is unresolved", () => {
    const record = { "a.ts": "function f0() {}\nconst viaAny: any = f0;\nexport function f() {\n  (f0 as any)();\n  (<any>f0)();\n  viaAny();\n}\n" };
    expect(callees(record, "a.ts", "f").resolved).toEqual([]);
    expect(texts(record, "a.ts", "f")).toHaveLength(3);
  });

  test("an overloaded function resolves to its one body, and a property holding a function does not resolve", () => {
    const record = {
      "a.ts": "export function o(a: number): number;\nexport function o(a: string): string;\nexport function o(a: any): any {\n  return a;\n}\nconst obj = { p: () => 1 };\nexport function f() {\n  o(1);\n  obj.p();\n}\n",
    };
    expect(callees(record, "a.ts", "f").resolved.map((ref) => ref.label)).toEqual(["o"]);
    expect(texts(record, "a.ts", "f")).toEqual(["obj.p"]);
  });
});
