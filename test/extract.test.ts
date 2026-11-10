import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { EXTRACTOR_VERSION, extract } from "../src/extract/extract.ts";
import { isCodeNode, lineCount, serializeGraph } from "../src/graph.ts";
import type { CodeNode, Graph } from "../src/graph.ts";
import { readFixtureTree } from "./fixture-tree.ts";

const fixture = fileURLToPath(new URL("fixtures/small", import.meta.url));
const goldenPath = fileURLToPath(new URL("golden/small.json", import.meta.url));
const ledgerPath = fileURLToPath(new URL("extractor-versions.json", import.meta.url));

const serialized = serializeGraph(extract(readFixtureTree(fixture)));

describe("the extractor on the small fixture", () => {
  test("matches the committed golden graph (UPDATE_GOLDEN=1 rewrites it)", () => {
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenPath, serialized);
    expect(serialized).toBe(readFileSync(goldenPath, "utf8"));
  });

  test("the fixture holds a file of every role and one with none", () => {
    const roles = new Set(
      extract(readFixtureTree(fixture)).nodes.flatMap((node) => (node.level === "file" ? [node.role] : [])),
    );
    expect(roles).toEqual(new Set(["source", "tests", "config", "docs", "generated", null]));
  });

  test("output is fixed for this extractor version", () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, string>;
    const hash = createHash("sha256").update(serialized).digest("hex");
    expect(
      ledger[EXTRACTOR_VERSION],
      `Extractor output changed or EXTRACTOR_VERSION ${EXTRACTOR_VERSION} has no ledger entry. ` +
        `Bump EXTRACTOR_VERSION in src/extract/extract.ts and append "<new version>": "<hash>" ` +
        `to test/extractor-versions.json, where the hash is the sha256 of the new output ` +
        `(currently ${hash} for version ${EXTRACTOR_VERSION}). Never edit an existing entry.`,
    ).toBe(hash);
  });

  test("ledger entries are append-only, so no two versions share an output", () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, string>;
    const hashes = Object.values(ledger);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe("extract", () => {
  const graph = extract(
    new Map([
      ["package.json", "{}\n"],
      ["a.ts", "one\ntwo\n"],
      ["lib/b.md", "x"],
      ["lib/pkg/package.json", "{}"],
      ["lib/pkg/c.js", ""],
    ]),
  );
  const byPath = (level: string, path: string) =>
    graph.nodes.find((node) => node.level === level && node.path === path);

  test("nests packages, folders and files by containment", () => {
    expect(byPath("package", "")?.parent).toBeNull();
    expect(byPath("folder", "lib")?.parent).toBe(byPath("package", "")?.id);
    expect(byPath("package", "lib/pkg")?.parent).toBe(byPath("folder", "lib")?.id);
    expect(byPath("file", "lib/pkg/c.js")?.parent).toBe(byPath("package", "lib/pkg")?.id);
  });

  test("counts lines, and containers sum their descendants", () => {
    expect(lineCount(byPath("file", "a.ts")!)).toBe(2);
    expect(lineCount(byPath("file", "lib/b.md")!)).toBe(1);
    expect(lineCount(byPath("file", "lib/pkg/c.js")!)).toBe(0);
    expect(lineCount(byPath("folder", "lib")!)).toBe(2);
    expect(lineCount(byPath("package", "")!)).toBe(5);
  });

  test("marks only files with a language adapter as analysed", () => {
    expect(byPath("file", "a.ts")).toMatchObject({ analysis: "analysed" });
    expect(byPath("file", "lib/pkg/c.js")).toMatchObject({ analysis: "analysed" });
    expect(byPath("file", "lib/b.md")).toMatchObject({ analysis: "not analysed" });
    expect(byPath("file", "package.json")).toMatchObject({ analysis: "not analysed" });
  });

  test("gives lockfiles the generated role, wherever they sit, and nothing else", () => {
    const locks = extract(
      new Map([
        ["package-lock.json", "{}\n".repeat(900)],
        ["npm-shrinkwrap.json", "{}"],
        ["yarn.lock", "x"],
        ["pnpm-lock.yaml", "x"],
        ["bun.lock", "x"],
        ["pkg/package-lock.json", "{}"],
        ["package.json", "{}"],
        ["lock.json", "{}"],
        ["my-yarn.lock", "x"],
        ["src/a.ts", "one\n"],
      ]),
    );
    const generated = locks.nodes
      .filter((node) => node.level === "file" && node.role === "generated")
      .map((node) => node.path);
    expect(generated).toEqual([
      "bun.lock",
      "npm-shrinkwrap.json",
      "package-lock.json",
      "pkg/package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]);
    expect(lineCount(locks.nodes.find((node) => node.path === "package-lock.json")!)).toBe(900);
  });

  test("does not depend on the order of the file tree", () => {
    const tree = readFixtureTree(fixture);
    expect(extract(new Map([...tree].reverse()))).toEqual(extract(tree));
  });
});

const codeNodes = (graph: Graph): CodeNode[] => graph.nodes.filter(isCodeNode);

/** The class and function nodes of one file, as "level qualifiedName start-end", in id order. */
function codeOf(source: string, path = "a.ts"): string[] {
  return codeNodes(extract(new Map([[path, source]]))).map(
    (node) => `${node.level} ${node.qualifiedName} ${node.range.start}-${node.range.end}`,
  );
}

describe("class and function nodes", () => {
  test("a function or class is named by its own name", () => {
    expect(codeOf("function f() {}\nclass C {}\nconst a = function b() {};\n")).toEqual([
      "class C 2-2",
      "function b 3-3",
      "function f 1-1",
    ]);
    expect(codeOf("module.exports = function legacy() {};", "a.js")).toEqual(["function legacy 1-1"]);
  });

  test("a class element is named by its key, with static, get and set as written", () => {
    const source = [
      "class A {",
      "  constructor() {}",
      "  get x() { return 1; }",
      "  set x(v) {}",
      "  static x() {}",
      "  static get y() { return 2; }",
      "  #p() {}",
      "  [Symbol.iterator]() {}",
      '  "a b"() {}',
      "  async *gen() {}",
      "}",
    ].join("\n");
    expect(codeOf(source)).toEqual([
      "class A 1-11",
      'function A."[Symbol.iterator]" 8-8',
      'function A."\\u0023p" 7-7',
      'function A."a b" 9-9',
      'function A."get x" 3-3',
      'function A."set x" 4-4',
      'function A."static get y" 6-6',
      'function A."static x" 5-5',
      "function A.constructor 2-2",
      "function A.gen 10-10",
    ]);
  });

  test("an initializer is named by what it is bound to", () => {
    const source = [
      "const f = () => 1;",
      "function g(cb = () => {}) {}",
      "const { h = () => 1 } = {};",
      "class A { onResize = () => {}; static #tick = function () {}; }",
      "const C = class {};",
      "const p = (() => 1) as () => number;",
    ].join("\n");
    expect(codeOf(source)).toEqual([
      "class A 4-4",
      "class C 5-5",
      'function A."\\u0023tick" 4-4',
      "function A.onResize 4-4",
      "function f 1-1",
      "function g 2-2",
      "function g.cb 2-2",
      "function h 3-3",
      "function p 6-6",
    ]);
  });

  test("an object literal member is named by the literal's access path and its key", () => {
    const source = [
      "const handlers = {",
      "  open() {},",
      "  close: () => 0,",
      "  nested: { reset: function () {} },",
      "  get size() { return 1; },",
      "};",
      "module.exports = { foo() {} };",
      "use({ bare() {} });",
    ].join("\n");
    expect(codeOf(source, "a.js")).toEqual([
      'function "get handlers.size" 5-5',
      'function "handlers.close" 3-3',
      'function "handlers.nested.reset" 4-4',
      'function "handlers.open" 2-2',
      'function "module.exports.foo" 7-7',
      "function bare 8-8",
    ]);
  });

  test("an assigned function is named by the assignment target", () => {
    const source = "Foo.prototype.bar = function () {};\nexports.helper = () => {};\nthis.run = () => {};\n";
    expect(codeOf(source, "a.js")).toEqual([
      'function "Foo.prototype.bar" 1-1',
      'function "exports.helper" 2-2',
      'function "this.run" 3-3',
    ]);
  });

  test("an anonymous default export is named default", () => {
    expect(codeOf("export default function () {}")).toEqual(["function default 1-1"]);
    expect(codeOf("export default class {}")).toEqual(["class default 1-1"]);
    expect(codeOf("export default () => 1;")).toEqual(["function default 1-1"]);
  });

  test("a callback is named by its callee and a string first argument", () => {
    const source = [
      'describe("parser", () => {',
      '  test("nests", () => {});',
      "});",
      "[1].map((n) => n).filter((n) => n);",
      "new Promise((resolve) => resolve(1));",
      "a.b.c(() => 1);",
    ].join("\n");
    expect(codeOf(source)).toEqual([
      'function "Promise() callback" 5-5',
      'function "c() callback" 6-6',
      'function "describe(\\"parser\\") callback" 1-3',
      'function "describe(\\"parser\\") callback"."test(\\"nests\\") callback" 2-2',
      'function "filter() callback" 4-4',
      'function "map() callback" 4-4',
    ]);
  });

  test("anything else is <function> or <class>", () => {
    const source = "(function () {})();\nconst list = [() => 1, class {}];\nf()(() => 1);\n";
    expect(codeOf(source)).toEqual([
      'class "<class>" 2-2',
      'function "<function>" 1-1',
      'function "<function>"@2 2-2',
      'function "<function>"@3 3-3',
    ]);
  });

  test("a function inside a namespace is named through the namespace", () => {
    expect(codeOf("namespace N.M {\n  export function f() {}\n}\n")).toEqual(['function "N.M.f" 2-2']);
    expect(codeOf("namespace N {\n  export const { f = () => {} } = {};\n}\n")).toEqual([
      'function "N.f" 2-2',
    ]);
    expect(codeOf("function g({ f = () => {} }) {}\n")).toEqual(["function g 1-1", "function g.f 1-1"]);
  });

  test("only syntax with a body is a node", () => {
    const source = [
      "function over(a: number): void;",
      "function over(a: string): void;",
      "function over(a: unknown) {}",
      "declare function ambient(): void;",
      "declare class Ambient { m(): void; }",
      "abstract class B { abstract m(): void; static { const x = 1; } }",
      "interface I { m(): void; }",
      "type F = () => void;",
    ].join("\n");
    expect(codeOf(source)).toEqual(["class B 6-6", "function over 3-3"]);
    expect(codeOf("export declare class D { m(): void; }\nexport function f(): void;\n", "a.d.ts")).toEqual([]);
  });

  test("siblings with the same text get ordinals in source order, across levels", () => {
    expect(codeOf("function f() {}\nfunction f() {}\nclass A {}\nfunction A() {}\n")).toEqual([
      "class A 3-3",
      "function A@2 4-4",
      "function f 1-1",
      "function f@2 2-2",
    ]);
    const graph = extract(new Map([["a.ts", "function f() {}\nfunction f() {}\n"]]));
    expect(codeNodes(graph).map((node) => node.name)).toEqual(["f", "f (2)"]);
  });

  test("a range runs from the first decorator or modifier to the end of the body, without JSDoc", () => {
    const source = "/**\n * Doc.\n */\n@sealed\nexport class A {\n  @log\n  static m() {\n  }\n}\n";
    expect(codeOf(source)).toEqual(["class A 4-9", 'function A."static m" 6-8']);
  });

  test("lines end at \\n only, whatever the TypeScript compiler counts", () => {
    expect(codeOf("function f() {\r\n}\r\nfunction g() {}\r\n")).toEqual(["function f 1-2", "function g 3-3"]);
    expect(codeOf('const s = "\u2028";\nfunction f() {}')).toEqual(["function f 2-2"]);
    expect(codeOf("const s = 1;\u2029function f() {}")).toEqual(["function f 1-1"]);
  });

  test("a node's parent is its file or the code node that contains it", () => {
    const graph = extract(readFixtureTree(fixture));
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const node of codeNodes(graph)) {
      const parent = byId.get(node.parent)!;
      expect(parent.path, node.id).toBe(node.path);
      if (isCodeNode(parent)) {
        expect(node.qualifiedName.startsWith(`${parent.qualifiedName}.`), node.id).toBe(true);
        expect(node.range.start).toBeGreaterThanOrEqual(parent.range.start);
        expect(node.range.end).toBeLessThanOrEqual(parent.range.end);
      } else {
        expect(parent.level, node.id).toBe("file");
        expect(node.range.end).toBeLessThanOrEqual(lineCount(parent));
      }
    }
  });

  describe("identities survive unrelated edits", () => {
    const shapes = readFileSync(new URL("fixtures/small/src/shapes.ts", import.meta.url), "utf8");
    const idsOf = (text: string) => new Set(codeNodes(extract(new Map([["shapes.ts", text]]))).map((node) => node.id));
    const before = idsOf(shapes);

    test("inserting a function and editing every body adds one id and changes none", () => {
      const after = idsOf(`function inserted() {}\n${shapes.replaceAll("return", "void 0;\n    return")}`);
      expect([...after].filter((id) => !before.has(id))).toEqual(["function:shapes.ts#inserted"]);
      expect([...before].filter((id) => !after.has(id))).toEqual([]);
    });

    test("inserting a same-text callback renumbers only callbacks with that text", () => {
      const after = idsOf(`[0].map((n) => n);\n${shapes}`);
      const others = (ids: Set<string>) => [...ids].filter((id) => !id.startsWith('function:shapes.ts#"map() callback"'));
      expect(others(after)).toEqual(others(before));
      expect(after.size).toBe(before.size + 1);
    });
  });
});

const sha32 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);

/** The digest of every file and code node, by id. */
function digestsOf(files: Record<string, string>): Map<string, string> {
  const graph = extract(new Map(Object.entries(files)));
  return new Map(graph.nodes.flatMap((node): [string, string][] => ("digest" in node ? [[node.id, node.digest]] : [])));
}

describe("digests", () => {
  const source = [
    "class Box {",
    "  grow() {",
    "    const inner = () => 1;",
    "    return inner();",
    "  }",
    "  shrink() {}",
    "}",
    "function other() {}",
    "",
  ].join("\n");

  test("a file's digest is the sha256 of its text, 32 hex digits", () => {
    const digests = digestsOf({ "a.ts": source, "notes.md": "hello\n" });
    expect(digests.get("file:a.ts")).toBe(sha32(source));
    expect(digests.get("file:notes.md")).toBe(sha32("hello\n"));
    expect(digests.get("file:a.ts")).toMatch(/^[0-9a-f]{32}$/);
  });

  test("a code node's digest is the sha256 of its declaration, first token to end of body", () => {
    const digests = digestsOf({ "a.ts": `// leading comment\n${source}` });
    expect(digests.get("function:a.ts#Box.grow")).toBe(
      sha32("grow() {\n    const inner = () => 1;\n    return inner();\n  }"),
    );
    expect(digests.get("function:a.ts#other")).toBe(sha32("function other() {}"));
  });

  test("identical text gives an identical digest across files, and a different text a different one", () => {
    const digests = digestsOf({ "a.ts": source, "lib/b.ts": source, "c.ts": `${source}// more\n` });
    expect(digests.get("file:lib/b.ts")).toBe(digests.get("file:a.ts"));
    expect(digests.get("function:lib/b.ts#Box.grow")).toBe(digests.get("function:a.ts#Box.grow"));
    expect(digests.get("file:c.ts")).not.toBe(digests.get("file:a.ts"));
    expect(digests.get("class:c.ts#Box")).toBe(digests.get("class:a.ts#Box"));
  });

  test("an edit inside a nested function changes it and its ancestors, and nothing else", () => {
    const before = digestsOf({ "a.ts": source });
    const after = digestsOf({ "a.ts": source.replace("=> 1", "=> 2") });
    const changed = [...before.keys()].filter((id) => before.get(id) !== after.get(id)).sort();
    expect(changed).toEqual([
      "class:a.ts#Box",
      "file:a.ts",
      "function:a.ts#Box.grow",
      "function:a.ts#Box.grow.inner",
    ]);
  });

  test("whitespace outside a function leaves its digest alone, and lines shifting above it too", () => {
    const before = digestsOf({ "a.ts": source });
    const after = digestsOf({ "a.ts": `\n\n// new header\n${source.replace("}\nfunction other", "}\n\n\nfunction other")}  \n` });
    expect(after.get("function:a.ts#other")).toBe(before.get("function:a.ts#other"));
    expect(after.get("function:a.ts#Box.shrink")).toBe(before.get("function:a.ts#Box.shrink"));
    expect(after.get("class:a.ts#Box")).toBe(before.get("class:a.ts#Box"));
    expect(after.get("file:a.ts")).not.toBe(before.get("file:a.ts"));
  });
});

describe("effect edges on the small fixture", () => {
  const graph = extract(readFixtureTree(fixture));
  const shown = graph.edges.map((edge) => {
    const owner = edge.from.slice(edge.from.indexOf(":") + 1);
    const target = typeof edge.target === "string" ? edge.target : JSON.stringify(edge.target.literal);
    return `${owner} ${edge.operation} ${target} ${edge.range.start}-${edge.range.end}`;
  });

  test("finds each resolvable call, and none of the unresolvable ones", () => {
    expect(shown).toEqual([
      "src/effects.mjs setTimeout none 8-8",
      'src/effects.cjs#"module.exports.load" fs readFileSync "config.json" 5-5',
      'src/effects.cjs#"module.exports.which" child_process spawnSync "which" 6-6',
      'src/effects.mjs#build child_process spawn "tar" 28-28',
      "src/effects.mjs#save fs/promises writeFile unknown 15-15",
      "src/effects.mjs#serve http createServer none 20-23",
      'src/effects.mjs#serve."createServer() callback" fs/promises readFile "index.html" 22-22',
      'src/effects.mjs#version child_process execFileSync "git" 11-11',
    ]);
  });
});

test("extraction stays fast on a 300-file tree", () => {
  const tree = new Map<string, string>();
  for (let i = 0; i < 300; i++) {
    const calls = Array.from({ length: 30 }, (_, j) => `  fs.readFileSync(path.join(dir, "f${j}"));\n  helper${j}(a, b);`);
    tree.set(`src/m${i}.mjs`, `import fs from "node:fs";\nimport path from "node:path";\nexport function run${i}(dir, a, b) {\n${calls.join("\n")}\n}\n`);
  }
  const started = performance.now();
  const graph = extract(tree);
  const seconds = (performance.now() - started) / 1000;
  expect(graph.edges).toHaveLength(300 * 30);
  expect(seconds).toBeLessThan(4);
});
