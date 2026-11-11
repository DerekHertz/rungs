import { describe, expect, test } from "vitest";
import { compare } from "../src/compare.ts";
import { extract } from "../src/extract/extract.ts";
import { nodeId } from "../src/graph.ts";
import type { FileTree, ImportEdge } from "../src/graph.ts";

const importsOf = (files: Record<string, string>): ImportEdge[] => [...extract(new Map(Object.entries(files))).imports];
const file = (path: string) => nodeId("file", path, "");

describe("import edges", () => {
  test("static imports, export from and type-only forms resolve to files with their lines", () => {
    const edges = importsOf({
      "a.ts": 'import { b } from "./b";\nimport type { C } from "./c.ts";\nexport * from "./d";\nexport type { E } from "./e";\nimport f = require("./f");\nimport "./g";\n',
      "b.ts": "export const b = 1;",
      "c.ts": "export type C = 1;",
      "d.ts": "",
      "e.ts": "export type E = 1;",
      "f.ts": "export = 1;",
      "g.ts": "",
    });
    expect(edges.map((e) => [e.syntax, e.typeOnly, "file" in e.target ? e.target.file : "?", e.range.start])).toEqual([
      ["import", false, file("b.ts"), 1],
      ["import", true, file("c.ts"), 2],
      ["export from", false, file("d.ts"), 3],
      ["export from", true, file("e.ts"), 4],
      ["import", false, file("f.ts"), 5],
      ["import", false, file("g.ts"), 6],
    ]);
    expect(edges.every((e) => e.from === file("a.ts"))).toBe(true);
  });

  test("a multi-line import spans its lines", () => {
    const [edge] = importsOf({ "a.ts": 'import {\n  x,\n  y,\n} from "./b";\n', "b.ts": "" });
    expect(edge?.range).toMatchObject({ start: 1, end: 4 });
  });

  test("extensions, index files and the .js-to-.ts mapping resolve", () => {
    const targets = importsOf({
      "src/a.ts": 'import "./util.js";\nimport "./lib";\nimport "../data.json";\nimport "./style.css";\n',
      "src/util.ts": "",
      "src/lib/index.ts": "",
      "data.json": "{}",
      "src/style.css": "",
    }).map((e) => e.target);
    expect(targets).toEqual([
      { file: file("src/util.ts") },
      { file: file("src/lib/index.ts") },
      { file: file("data.json") },
      { file: file("src/style.css") },
    ]);
  });

  test("literal require and import() are edges; non-literal ones and shadowed require are not", () => {
    const edges = importsOf({
      "a.js":
        'const b = require("./b");\nasync function f(name) {\n  await import("./c");\n  await import(name);\n  return require(name);\n}\nfunction g(require) { return require("./d"); }\n',
      "b.js": "",
      "c.js": "",
      "d.js": "",
    });
    expect(edges.map((e) => [e.syntax, e.specifier, e.range.start])).toEqual([
      ["require", "./b", 1],
      ["import()", "./c", 3],
    ]);
  });

  test("a query on a relative specifier names the same file", () => {
    const [edge] = importsOf({ "a.mjs": 'await import("./b.mjs?fresh");', "b.mjs": "" });
    expect(edge?.target).toEqual({ file: file("b.mjs") });
  });

  test("a package outside the repo is an external edge by its name, never a node", () => {
    const graph = extract(new Map([["a.ts", 'import x from "lodash/fp";\nimport y from "@scope/pkg/sub";\nimport z from "node:fs";\nimport w from "fs/promises";\n']]));
    expect(graph.imports.map((e) => e.target)).toEqual([
      { external: "lodash" },
      { external: "@scope/pkg" },
      { external: "node:fs" },
      { external: "fs" },
    ]);
    expect(graph.nodes.map((n) => n.path).sort()).toEqual(["", "a.ts"]);
  });

  test("an import that cannot be resolved is shown as unresolved", () => {
    const edges = importsOf({ "a.ts": 'import "./missing";\nimport "#internal";\n' });
    expect(edges.map((e) => e.target)).toEqual([{ unresolved: true }, { unresolved: true }]);
    expect(edges.map((e) => e.specifier)).toEqual(["./missing", "#internal"]);
  });

  test("a package of this tree resolves through its main and exports; a miss is unresolved", () => {
    const edges = importsOf({
      "package.json": '{"name":"root"}',
      "app/index.ts": 'import "@acme/core";\nimport "@acme/core/feature";\nimport "@acme/util";\nimport "@acme/ghost";\n',
      "packages/core/package.json": '{"name":"@acme/core","exports":{".":"./src/main.ts","./feature":"./src/feature.ts"}}',
      "packages/core/src/main.ts": "",
      "packages/core/src/feature.ts": "",
      "packages/util/package.json": '{"name":"@acme/util","main":"lib/entry.js"}',
      "packages/util/lib/entry.js": "",
    });
    expect(edges.map((e) => e.target)).toEqual([
      { file: file("packages/core/src/main.ts") },
      { file: file("packages/core/src/feature.ts") },
      { file: file("packages/util/lib/entry.js") },
      { external: "@acme/ghost" },
    ]);
    const broken = importsOf({
      "a.ts": 'import "pkg/missing";\n',
      "p/package.json": '{"name":"pkg","main":"nope.js"}',
    });
    expect(broken[0]?.target).toEqual({ unresolved: true });
  });

  test("a file's own package name resolves from inside it too", () => {
    const [edge] = importsOf({ "package.json": '{"name":"self","main":"./index.js"}', "index.js": "", "lib/a.js": 'require("self");' });
    expect(edge?.target).toEqual({ file: file("index.js") });
  });

  test("declaration files and non-JS files are not scanned for imports", () => {
    expect(importsOf({ "a.d.ts": 'import "./b";', "b.ts": "", "c.md": 'import "./b"' })).toEqual([]);
  });
});

describe("compare reports import edges", () => {
  const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));
  const base = extract(tree({ "a.ts": 'import "./b";\nimport "lodash";\n', "b.ts": "export const b = 1;", "c.ts": "" }));

  test("added and removed edges, not moved by lines", () => {
    const head = extract(tree({ "a.ts": '\n\nimport "./b";\nimport "./c";\n', "b.ts": "export const b = 1;", "c.ts": "" }));
    const changes = compare(base, head).imports;
    expect(changes.map((c) => [c.kind, c.edge.specifier])).toEqual([
      ["removed", "lodash"],
      ["added", "./c"],
    ]);
  });

  test("a moved file is no change to the edges into it", () => {
    const head = extract(tree({ "a.ts": 'import "./moved/b";\nimport "lodash";\n', "moved/b.ts": "export const b = 1;", "c.ts": "" }));
    expect(compare(base, head).imports).toEqual([]);
  });
});
